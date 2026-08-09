'use strict';
/**
 * Data Health: the standing mechanism that keeps the vault accurate, current
 * and complete. Ported from isconl-agent's server.js (~9631-9691).
 *
 * Every check is computed, plain-language, and names the exact file or task
 * -- this is what catches the next silent corruption (like the 28 Jul
 * SharePoint error page that overwrote 12 career files) before it costs
 * anything.
 *
 * CROSS-ENGINE: Tasks (scope/tasks.tsv) and Inbox (scope/inbox.tsv) are read
 * the same way as every other module here -- readTSV IS the wire boundary to
 * `vault`'s shared store, same reasoning as notifications.js. The corruption
 * and schema-drift checks scan EVERY vault file, not just pulse's own, which
 * is inherently a vault-wide concern -- `listVaultFiles`/`readVaultFileRaw`
 * are injected (vault's HTTP API once split out; @isconl/vault's
 * createVaultStore already exposes the equivalent `syncableFiles`/`schema`
 * locally). Left unset, those two checks simply contribute no issues rather
 * than failing -- the tasks/finance/inbox checks still run standalone.
 */

function createDataHealthClient(opts) {
  const {
    readTSV,
    listVaultFiles = async () => [],
    readVaultFileRaw = async () => null,
    vaultSchema = {},
  } = opts;
  if (!readTSV) throw new Error('createDataHealthClient requires readTSV');

  async function checkDataHealth(now = new Date()) {
    const issues = [];
    const today = now.toISOString().slice(0, 10);

    // 1. Corruption: any vault file whose content is an HTML error page.
    try {
      for (const rel of (await listVaultFiles()) || []) {
        const head = await readVaultFileRaw(rel);
        if (head && /^\s*(<!DOCTYPE|<html)/i.test(head.slice(0, 200))) {
          issues.push({ severity: 'critical', area: 'corruption',
            text: `${rel} is not real data - it holds a web error page. Restore it from OneDrive version history.` });
        }
      }
    } catch {}

    // 2. Schema drift: files missing columns the schema expects.
    for (const [rel, header] of Object.entries(vaultSchema)) {
      try {
        const raw = await readVaultFileRaw(rel);
        if (raw == null) continue;
        const have = raw.replace(/^﻿/, '').split(/\r?\n/)[0].split('\t');
        const missing = header.split('\t').filter(h => !have.includes(h));
        if (missing.length) issues.push({ severity: 'warn', area: 'schema',
          text: `${rel} is missing the ${missing.join(', ')} column${missing.length > 1 ? 's' : ''} - restart the agent to upgrade it.` });
      } catch {}
    }

    // 3. Tasks: every task must say why it exists; every closed task must say
    //    why it closed; overdue work is named, not implied.
    const tasks = await readTSV('scope/tasks.tsv');
    const noWhy = tasks.filter(t => !t.WHY || t.WHY === '-');
    if (noWhy.length) issues.push({ severity: 'warn', area: 'tasks',
      text: `${noWhy.length} task${noWhy.length > 1 ? 's have' : ' has'} no explanation of why ${noWhy.length > 1 ? 'they exist' : 'it exists'}: ${noWhy.slice(0, 5).map(t => t.ID).join(', ')}${noWhy.length > 5 ? '·' : ''}` });
    const noRes = tasks.filter(t => t.STATUS === 'done' && (!t.RESOLUTION || t.RESOLUTION === '-'));
    if (noRes.length) issues.push({ severity: 'warn', area: 'tasks',
      text: `${noRes.length} finished task${noRes.length > 1 ? 's' : ''} do${noRes.length > 1 ? '' : 'es'} not say why ${noRes.length > 1 ? 'they were' : 'it was'} closed: ${noRes.slice(0, 5).map(t => t.ID).join(', ')}${noRes.length > 5 ? '·' : ''}` });
    const overdue = tasks.filter(t => t.STATUS !== 'done' && t.DUE_DATE && t.DUE_DATE !== '-' && t.DUE_DATE < today);
    if (overdue.length) issues.push({ severity: 'info', area: 'tasks',
      text: `${overdue.length} open task${overdue.length > 1 ? 's are' : ' is'} past due: ${overdue.slice(0, 5).map(t => `${t.ID} (${t.DUE_DATE})`).join(', ')}${overdue.length > 5 ? '·' : ''}` });

    // 4. Money freshness: balances older than a week are guesses, not figures.
    const staleAcc = (await readTSV('finance/accounts.tsv'))
      .filter(a => a.ASOF && a.ASOF !== '-' && (Date.parse(today) - Date.parse(a.ASOF)) > 7 * 864e5);
    if (staleAcc.length) issues.push({ severity: 'info', area: 'finance',
      text: `${staleAcc.length} account balance${staleAcc.length > 1 ? 's are' : ' is'} more than a week old - refresh ${staleAcc.slice(0, 4).map(a => a.NAME).join(', ')}${staleAcc.length > 4 ? '·' : ''}` });

    // 5. Inbox: captured messages nobody has looked at in three days.
    const staleInbox = (await readTSV('scope/inbox.tsv'))
      .filter(m => m.STATUS === 'new' && m.CAPTURED_AT && (Date.parse(today) - Date.parse(m.CAPTURED_AT)) > 3 * 864e5);
    if (staleInbox.length) issues.push({ severity: 'info', area: 'inbox',
      text: `${staleInbox.length} captured message${staleInbox.length > 1 ? 's' : ''} still unread after three days.` });

    return { checkedAt: new Date().toISOString(),
      healthy: issues.filter(i => i.severity !== 'info').length === 0, issues };
  }

  return { checkDataHealth };
}

module.exports = { createDataHealthClient };
