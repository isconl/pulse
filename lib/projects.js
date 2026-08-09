'use strict';
/**
 * Project status board. Ported from isconl-agent's server.js (~8719-8767).
 *
 * One space per project he is building. Each carries its registered venture
 * row (finance/ventures.tsv) plus its deployed Render instance: pinged
 * server-side because browser CORS makes a client-side check impossible.
 */

function createProjectsClient(opts) {
  const { readTSV, rewriteTSV, auditLog = { log: () => {} }, fetchFn = fetch, pingTimeoutMs = 6000 } = opts;
  if (!readTSV || !rewriteTSV) throw new Error('createProjectsClient requires readTSV/rewriteTSV');

  async function pingUrl(urlStr) {
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), pingTimeoutMs);
      const r = await fetchFn(urlStr, { method: 'GET', signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      return { up: r.status < 500, status: r.status, ms: Date.now() - t0 };
    } catch {
      return { up: false, status: 0, ms: Date.now() - t0 };
    }
  }

  async function listProjects() {
    const ventures = readTSV('finance/ventures.tsv');
    return Promise.all(ventures.map(async v => {
      const urlStr = (v.RENDER_URL && v.RENDER_URL !== '-') ? v.RENDER_URL : '';
      if (!urlStr) return { ...v, live: null };
      return { ...v, live: await pingUrl(urlStr) };
    }));
  }

  function setProjectUrl({ id, url }) {
    if (!id) throw new Error('which project');
    const urlStr = String(url || '').trim();
    if (urlStr && !/^https:\/\/[\w.-]+/.test(urlStr)) throw new Error('a deployed instance is an https URL');
    let found = false;
    rewriteTSV('finance/ventures.tsv', rows => rows.map(r => {
      if (r.ID !== id) return r;
      found = true; return { ...r, RENDER_URL: urlStr || '-' };
    }));
    if (!found) throw new Error(`No venture ${id}`);
    auditLog.log('project_url_set', { id, url: urlStr || '(cleared)' });
    return { success: true };
  }

  return { listProjects, setProjectUrl, pingUrl };
}

module.exports = { createProjectsClient };
