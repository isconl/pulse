'use strict';
/**
 * Telegram bot: long-polling channel mechanics. Ported from isconl-agent's
 * server.js (~3482-3707).
 *
 * ARCHITECTURAL SPLIT (deliberate, not an oversight): the original
 * tgHandleText() was one giant command dispatcher reaching directly into
 * tasks, finance, decisions, and chat -- i.e. cross-engine orchestration.
 * That's `hub`'s job under the hub-and-spoke design (Decision 003), not
 * `pulse`'s. So this module owns the CHANNEL (how to poll, how to lock to
 * one chat, how to mask sensitive numbers before anything leaves the vault,
 * retry/fallback on send) and takes `onText`/`onPhoto` callbacks the
 * orchestrator supplies -- pulse never hardcodes what a message DOES.
 *
 * THE LOCK IS THE ARCHITECTURE (kept verbatim from the original comment,
 * because it's the single most important security property here): only the
 * configured chat id is ever answered. Every other sender is silently
 * ignored and logged -- no anonymous bootstrap surface. Bot chats are not
 * end-to-end encrypted, so numbers are masked to their last 3 digits before
 * anything is sent, and secrets never travel over this channel at all.
 */

// "KCB business (1283507471)" -> "KCB business (***471)".
function mask(s) {
  return String(s).replace(/\d{5,}/g, (m) => '***' + m.slice(-3));
}

/**
 * @param {object} opts
 * @param {() => string} opts.getBotToken
 * @param {() => string} opts.getChatId - the ONE chat id this bot ever answers
 * @param {(text: string, ctx: {chatId:string, messageId:number}) => Promise<void>} [opts.onText] - called for a locked-in text message; the handler is responsible for calling send() itself
 * @param {(photo: {fileId:string, messageId:number}, ctx: {chatId:string}) => Promise<void>} [opts.onPhoto]
 * @param {{log:Function}} [opts.auditLog]
 * @param {number} [opts.pollIntervalMs=3000]
 * @param {typeof fetch} [opts.fetchFn] - injectable for testing
 */
function createTelegramBot(opts) {
  const {
    getBotToken, getChatId,
    onText = async () => {}, onPhoto = async () => {},
    auditLog = { log: () => {} },
    pollIntervalMs = 3000,
    fetchFn = fetch,
  } = opts;
  if (!getBotToken || !getChatId) throw new Error('createTelegramBot requires getBotToken and getChatId');

  function api(method, params) {
    return fetchFn(`https://api.telegram.org/bot${getBotToken()}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    }).then(r => r.json()).catch(e => ({ ok: false, description: String(e.message || e) }));
  }

  /** Markdown send with a plain-text fallback if Telegram rejects the markdown (unbalanced formatting, etc). */
  function send(text, extra = {}) {
    if (!getBotToken() || !getChatId()) return Promise.resolve(null);
    return api('sendMessage', { chat_id: getChatId(), text: String(text).slice(0, 4000), parse_mode: 'Markdown', ...extra })
      .then(r => r.ok ? r : api('sendMessage', { chat_id: getChatId(), text: String(text).slice(0, 4000) }));
  }

  async function getFile(fileId) {
    const f = await api('getFile', { file_id: fileId });
    if (!f.ok) return null;
    const bin = await fetchFn(`https://api.telegram.org/file/bot${getBotToken()}/${f.result.file_path}`).then(r => r.arrayBuffer());
    return { filePath: f.result.file_path, bytes: Buffer.from(bin) };
  }

  async function handleUpdate(u) {
    const msg = u.message || u.edited_message;
    if (!msg) return;
    const from = String(msg.chat?.id || '');
    if (!getChatId() || from !== String(getChatId())) {
      // The lock: logged locally so the owner can find their own chat id, never answered.
      auditLog.log('telegram_ignored', { chatId: from, hasText: !!msg.text });
      return;
    }
    try {
      if (msg.photo?.length) {
        const photo = msg.photo[msg.photo.length - 1];
        return await onPhoto({ fileId: photo.file_id, messageId: msg.message_id }, { chatId: from });
      }
      if (msg.text) return await onText(msg.text, { chatId: from, messageId: msg.message_id });
    } catch (e) {
      auditLog.log('telegram_error', { error: String(e.message || e).slice(0, 120) });
      await send('That hit an error -- it is in the audit log.');
    }
  }

  const state = { offset: 0, polling: false, started: false };

  /** One poll cycle. Exactly one host may poll a given bot token -- two long-pollers fight over getUpdates and Telegram 409s them both. */
  async function poll() {
    if (state.polling || !getBotToken()) return;
    state.polling = true;
    try {
      const r = await api('getUpdates', { timeout: 25, offset: state.offset });
      for (const u of (r.result || [])) {
        state.offset = u.update_id + 1;
        await handleUpdate(u);
      }
      if (!state.started && r.ok) {
        state.started = true;
        auditLog.log('telegram_polling_started', { locked: !!getChatId() });
      }
    } catch { /* offline; next tick retries */ }
    finally { state.polling = false; }
  }

  let loopHandle = null;
  function startPolling() {
    if (loopHandle) return;
    loopHandle = setInterval(poll, pollIntervalMs);
    if (loopHandle.unref) loopHandle.unref();
  }
  function stopPolling() {
    if (loopHandle) clearInterval(loopHandle);
    loopHandle = null;
  }

  return { api, send, getFile, handleUpdate, poll, startPolling, stopPolling, mask, state };
}

module.exports = { createTelegramBot, mask };
