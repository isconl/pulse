'use strict';
/**
 * GitHub integration: REST client, gh-CLI fallback, and contribution-calendar
 * caching. Ported from isconl-agent's server.js (~702-750, 3820-3858,
 * 4024-4055, plus the snapshot/contributions endpoints at ~11785-11929 --
 * those become HTTP routes when pulse gets its service wrapper, not part of
 * this module).
 *
 * The REST client exists specifically because `gh` CLI isn't installed or
 * authenticated on every host (e.g. a Render container) -- it needs nothing
 * but a token and works identically everywhere; the gh-CLI path is the
 * fallback for a workstation that never configured a token.
 */

const https = require('https');
const { exec, execFile } = require('child_process');

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
 * @param {() => string} opts.getToken - resolve the current GITHUB_TOKEN (from wherever config actually lives)
 * @param {() => string} [opts.getOwner] - resolve the default GitHub username/org (no hardcoded fallback -- see genericization notes)
 * @param {{log:Function}} [opts.auditLog]
 * @param {string} [opts.cacheFile] - where the contribution-calendar cache persists across restarts
 */
function createGithubClient(opts) {
  const { getToken, getOwner = () => '', auditLog = { log: () => {} }, cacheFile } = opts;
  if (!getToken) throw new Error('createGithubClient requires getToken');

  async function githubApi(pathAndQuery) {
    const token = getToken();
    if (!token) return null;
    try {
      const res = await httpsRequest({
        hostname: 'api.github.com', path: pathAndQuery, method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'isconl-pulse',
        },
      });
      if (res.status >= 200 && res.status < 300) return res.data;
      auditLog.log('github_api_error', { path: pathAndQuery.slice(0, 60), status: res.status,
        message: String(res.data?.message || '').slice(0, 120) });
      return null;
    } catch (e) {
      auditLog.log('github_api_error', { path: pathAndQuery.slice(0, 60), reason: String(e.message || e).slice(0, 120) });
      return null;
    }
  }

  /** Shell-string form. Prefer runGhArgs() for anything with dynamic/user-influenced arguments -- exec() re-splits on spaces/quotes, execFile() doesn't. */
  function runGhCommand(cmdStr) {
    return new Promise((resolve) => {
      const fullCmd = cmdStr.trim().startsWith('gh') ? cmdStr.trim() : `gh ${cmdStr.trim()}`;
      exec(fullCmd, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        auditLog.log('gh_cli_exec', { cmd: fullCmd, success: !err });
        resolve(err ? { success: false, output: stderr || err.message } : { success: true, output: stdout });
      });
    });
  }

  /** argv form via execFile -- bypasses the shell entirely, so nothing in `args` gets reinterpreted. Use this one. */
  function runGhArgs(args) {
    return new Promise((resolve) => {
      execFile('gh', args, { maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        auditLog.log('gh_cli_exec', { cmd: 'gh ' + args[0] + ' ' + (args[1] || ''), success: !err });
        resolve(err ? { success: false, output: stderr || err.message } : { success: true, output: stdout });
      });
    });
  }

  // -- contribution calendar, cached ------------------------------------------
  let cache = { at: 0, data: null };
  if (cacheFile) {
    try { cache = JSON.parse(require('fs').readFileSync(cacheFile, 'utf8')); } catch {}
  }
  function saveCache() {
    if (!cacheFile) return;
    try { require('fs').writeFileSync(cacheFile, JSON.stringify(cache)); } catch {}
  }

  /** Token-first (works on any host), gh CLI as fallback. Returns { totalContributions, days, error }. */
  async function fetchContributions() {
    const login = getOwner();
    if (!login) return { totalContributions: 0, days: [], error: 'no GitHub owner configured' };
    const q = 'query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}';
    const out = { totalContributions: 0, days: [], error: null };
    const token = getToken();
    let cal = null;

    if (token) {
      try {
        const r = await httpsRequest({
          hostname: 'api.github.com', path: '/graphql', method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'isconl-pulse' },
        }, JSON.stringify({ query: q, variables: { login } }));
        cal = r.data?.data?.user?.contributionsCollection?.contributionCalendar || null;
        if (!cal) out.error = `graphql ${r.status}`;
      } catch (e) { out.error = String(e.message || e).slice(0, 120); }
    }
    if (!cal) {
      const r = await runGhArgs(['api', 'graphql', '-f', `query=${q}`, '-F', `login=${login}`]);
      try {
        cal = JSON.parse(r.output)?.data?.user?.contributionsCollection?.contributionCalendar || null;
        if (cal) out.error = null;
        else out.error = out.error || 'no calendar returned';
      } catch (e) { out.error = out.error || String(r.output || e.message).slice(0, 200); }
    }
    if (cal) {
      out.totalContributions = cal.totalContributions || 0;
      out.days = (cal.weeks || []).flatMap(w => (w.contributionDays || []).map(d => ({ date: d.date, count: d.contributionCount })));
    }
    return out;
  }

  /** Cached wrapper -- refreshes in the background if the cache is stale, returns whatever's cached immediately (a stale map beats a spinner). */
  async function getContributions({ maxAgeMs = 6 * 60 * 60 * 1000, force = false } = {}) {
    const stale = force || !cache.data || (Date.now() - cache.at) > maxAgeMs;
    if (stale) {
      const fresh = await fetchContributions();
      if (!fresh.error) {
        cache = { at: Date.now(), data: fresh };
        saveCache();
      }
      return cache.data || fresh;
    }
    return cache.data;
  }

  return { githubApi, runGhCommand, runGhArgs, fetchContributions, getContributions };
}

module.exports = { createGithubClient, httpsRequest };
