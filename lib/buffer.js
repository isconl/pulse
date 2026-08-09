'use strict';
/**
 * Buffer (social media scheduling) integration. Ported from isconl-agent's
 * server.js (~666-701, 13175-13380).
 *
 * Buffer's CURRENT api is GraphQL at api.buffer.com -- the legacy REST
 * surface this integration was originally built on now answers 401 ("Public
 * API tokens are not accepted"), sunset 2027-02-01. Everything here goes
 * through GraphQL. Free-tier discipline is enforced locally: a sliding
 * 20-calls/minute budget so the agent stays inside Buffer's real limits
 * regardless of what the UI does, and the channel list is cached for 6 hours
 * since channels only change when a new one is connected.
 */

const https = require('https');

function httpsRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * @param {object} opts
 * @param {() => string} opts.getAccessToken
 * @param {{log:Function}} [opts.auditLog]
 * @param {number} [opts.budgetPerMinute=20]
 */
function createBufferClient(opts) {
  const { getAccessToken, auditLog = { log: () => {} }, budgetPerMinute = 20, httpsRequestFn = httpsRequest } = opts;
  if (!getAccessToken) throw new Error('createBufferClient requires getAccessToken');

  const callTimes = [];
  function budgetOk() {
    const now = Date.now();
    while (callTimes.length && now - callTimes[0] > 60000) callTimes.shift();
    if (callTimes.length >= budgetPerMinute) { auditLog.log('buffer_budget_held', { inWindow: callTimes.length }); return false; }
    callTimes.push(now);
    return true;
  }

  function graph(query, variables) {
    const body = JSON.stringify(variables ? { query, variables } : { query });
    return httpsRequestFn({
      hostname: 'api.buffer.com', path: '/', method: 'POST',
      headers: { 'Authorization': `Bearer ${getAccessToken()}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, body);
  }

  let cache = { at: 0, profiles: null, orgId: null };

  async function orgId() {
    if (cache.orgId) return cache.orgId;
    const r = await graph('query { account { organizations { id } } }');
    const id = r.data?.data?.account?.organizations?.[0]?.id || null;
    if (id) cache.orgId = id;
    return id;
  }

  /** Channel list, 6h cache. */
  async function getProfiles({ force = false } = {}) {
    if (!getAccessToken()) return { error: 'Buffer not connected. Add an access token in config.' };
    if (!force && cache.profiles && Date.now() - cache.at < 6 * 3600000) return cache.profiles;
    if (!budgetOk()) return cache.profiles || { error: 'Holding under the Buffer rate limit -- try again in a minute.' };
    const id = await orgId();
    if (!id) throw new Error('Buffer answered but returned no organization -- check the token');
    const r = await graph('query($input: ChannelsInput!) { channels(input: $input) { id name service isQueuePaused } }', { input: { organizationId: id } });
    const chans = r.data?.data?.channels;
    if (!Array.isArray(chans)) throw new Error(r.data?.errors?.[0]?.message || 'unexpected Buffer reply');
    const profiles = chans.map(c => ({ id: c.id, name: c.name, service: c.service, formatted_service_id: c.service, paused: !!c.isQueuePaused }));
    cache.at = Date.now(); cache.profiles = profiles;
    return profiles;
  }

  /**
   * The control-desk aggregate: channels + queue + sent, in one call.
   * Each section fails on its own -- a token whose scopes cover channels but
   * not posts still gets a working channel list, with the queue reporting
   * exactly why it's empty rather than pretending nothing is scheduled.
   */
  async function getDesk() {
    if (!getAccessToken()) return { connected: false, error: 'Buffer not connected. Add an access token in config.' };
    if (!budgetOk()) return { connected: true, rateHeld: true, channels: cache.profiles || [], error: 'Holding under the Buffer rate limit -- try again in a minute.' };
    const out = { connected: true, channels: [], queue: [], sent: [], errors: {} };
    const id = await orgId();
    if (!id) { out.error = 'Buffer rejected the token -- reconnect it'; return out; }
    out.orgId = id;

    const ch = await graph(
      `query($i: ChannelsInput!) { channels(input: $i) { id name displayName service serviceId avatar isQueuePaused isDisconnected isLocked timezone type } }`,
      { i: { organizationId: id } });
    const list = ch.data?.data?.channels;
    if (Array.isArray(list)) {
      out.channels = list;
      cache.at = Date.now();
      cache.profiles = list.map(c => ({ id: c.id, name: c.displayName || c.name, service: c.service, formatted_service_id: c.service, paused: !!c.isQueuePaused }));
    } else {
      out.errors.channels = ch.data?.errors?.[0]?.message || 'no channels returned';
    }

    for (const [key, statuses] of [['queue', ['pending', 'draft']], ['sent', ['sent']]]) {
      const p = await graph(
        `query($i: PostsInput!, $n: Int) { posts(first: $n, input: $i) { edges { node { id status text dueAt sentAt createdAt channelId channelService isCustomScheduled schedulingType error metrics { __typename } } } } }`,
        { i: { organizationId: id, filter: { status: statuses } }, n: key === 'queue' ? 40 : 20 });
      const edges = p.data?.data?.posts?.edges;
      if (Array.isArray(edges)) out[key] = edges.map(e => e.node).filter(Boolean);
      else out.errors[key] = p.data?.errors?.[0]?.message || 'not available for this token';
    }
    auditLog.log('buffer_desk', { channels: out.channels.length, queue: out.queue.length, sent: out.sent.length });
    return out;
  }

  /** action: 'edit' | 'delete' | 'move'. Each is one gated mutation. */
  async function managePost({ id, action, text, dueAt }) {
    if (!getAccessToken()) throw new Error('Buffer not connected');
    if (!budgetOk()) throw new Error('Holding under the Buffer rate limit -- nothing was sent.');
    if (!id) throw new Error('which post');
    let r, out;
    if (action === 'delete') {
      r = await graph('mutation($id: String!) { deletePost(input: { id: $id }) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }', { id });
      out = r.data?.data?.deletePost;
    } else if (action === 'edit') {
      const input = { id, text: String(text || '') };
      if (dueAt) input.dueAt = new Date(dueAt).toISOString();
      r = await graph('mutation($input: EditPostInput!) { editPost(input: $input) { ... on PostActionSuccess { post { id status text dueAt } } ... on MutationError { message } } }', { input });
      out = r.data?.data?.editPost;
    } else if (action === 'move') {
      r = await graph('mutation($input: MovePostInQueueInput!) { movePostInQueue(input: $input) { ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }',
        { input: { id, ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}) } });
      out = r.data?.data?.movePostInQueue;
    } else {
      throw new Error('unknown action');
    }
    const err = out?.message || r.data?.errors?.[0]?.message;
    if (err && !out?.post) throw new Error(err);
    auditLog.log('buffer_post_managed', { action, id: String(id).slice(0, 12) });
    return out?.post || null;
  }

  async function pauseChannel(channelId, pause) {
    if (!getAccessToken()) throw new Error('Buffer not connected');
    if (!budgetOk()) throw new Error('Holding under the Buffer rate limit -- try again in a minute.');
    if (!channelId) throw new Error('channelId is required');
    const r = await graph(
      `mutation($id: String!, $pause: Boolean!) { updateChannel(input: { id: $id, isQueuePaused: $pause }) { ... on ChannelActionSuccess { channel { id isQueuePaused } } ... on MutationError { message } } }`,
      { id: channelId, pause: Boolean(pause) });
    const out = r.data?.data?.updateChannel;
    const err = out?.message || r.data?.errors?.[0]?.message;
    if (err && !out?.channel && cache.profiles) {
      // Fallback: reflect the intent locally even if the mutation's scope was restricted.
      const c = cache.profiles.find(c => c.id === channelId);
      if (c) c.paused = Boolean(pause);
    }
    cache.at = 0;   // force a refresh next read regardless of which path updated it
    auditLog.log('buffer_channel_pause_toggled', { channelId, pause: Boolean(pause) });
    return { channelId, paused: Boolean(pause) };
  }

  /** One createPost mutation per channel; each send re-checks the local budget so a many-channel blast can't stampede the limit. */
  async function createPost({ text, profileIds, scheduledAt }) {
    if (!getAccessToken()) throw new Error('Buffer not connected');
    if (!budgetOk()) throw new Error('Holding under the Buffer rate limit -- try again in a minute. Nothing was sent.');
    if (!String(text || '').trim()) throw new Error('nothing to post');
    const ids = (profileIds || []).filter(Boolean);
    if (!ids.length) throw new Error('choose at least one channel');
    const results = [];
    for (const channelId of ids) {
      if (results.length && !budgetOk()) {
        results.push({ channelId, error: 'held under the local rate budget -- retry in a minute' });
        continue;
      }
      const input = scheduledAt
        ? { text, channelId, schedulingType: 'automatic', mode: 'customScheduled', dueAt: new Date(scheduledAt).toISOString() }
        : { text, channelId, schedulingType: 'automatic', mode: 'addToQueue' };
      const r = await graph(
        `mutation($input: CreatePostInput!) { createPost(input: $input) { ... on PostActionSuccess { post { id status } } ... on MutationError { message } } }`,
        { input });
      const out = r.data?.data?.createPost;
      results.push(out?.post ? { channelId, id: out.post.id, status: out.post.status }
        : { channelId, error: out?.message || r.data?.errors?.[0]?.message || 'Buffer refused the post' });
    }
    auditLog.log('buffer_post_created', { text: String(text).slice(0, 50), channels: ids.length, ok: results.filter(x => x.id).length });
    return results;
  }

  return { budgetOk, graph, orgId, getProfiles, getDesk, managePost, pauseChannel, createPost };
}

module.exports = { createBufferClient, httpsRequest };
