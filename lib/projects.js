'use strict';
/**
 * Project status board. Ported from isconl-agent's server.js (~8719-8767).
 *
 * One space per project he is building. Each carries its registered venture
 * row (finance/ventures.tsv) plus its deployed instance, pinged server-side
 * because browser CORS makes a client-side check impossible.
 *
 * BI26091916: the probe is VENDOR-NEUTRAL and always has been -- `pingUrl`
 * does a plain HTTPS GET against whatever URL the venture row holds, and the
 * web UI already labels that field "Deployed URL". Only the names said
 * otherwise. The remaining one is the TSV column, still `RENDER_URL`, which
 * cannot be renamed without a schema migration on live data; that rename
 * belongs to the `stock` port, where the schema is being redefined anyway.
 * Nothing here is Render-specific, so there is no dead vendor code to remove
 * -- do not "fix" this by deleting the probe.
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
    const ventures = await readTSV('finance/ventures.tsv');
    return Promise.all(ventures.map(async v => {
      const urlStr = (v.RENDER_URL && v.RENDER_URL !== '-') ? v.RENDER_URL : '';
      if (!urlStr) return { ...v, live: null };
      return { ...v, live: await pingUrl(urlStr) };
    }));
  }

  async function setProjectUrl({ id, url }) {
    if (!id) throw new Error('which project');
    const urlStr = String(url || '').trim();
    if (urlStr && !/^https:\/\/[\w.-]+/.test(urlStr)) throw new Error('a deployed instance is an https URL');
    let found = false;
    await rewriteTSV('finance/ventures.tsv', rows => rows.map(r => {
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
