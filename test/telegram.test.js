'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramBot, mask } = require('../lib/telegram');

function jsonResponse(body) {
  return { json: async () => body, arrayBuffer: async () => Buffer.from('') };
}

function makeBot(overrides = {}) {
  const calls = [];
  const logs = [];
  const bot = createTelegramBot({
    getBotToken: () => 'test-token',
    getChatId: () => '111',
    auditLog: { log: (event, data) => logs.push({ event, data }) },
    fetchFn: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse({ ok: true, result: [] });
    },
    ...overrides,
  });
  return { bot, calls, logs };
}

test('mask() reduces long digit runs to their last 3 digits', () => {
  assert.equal(mask('KCB business (1283507471)'), 'KCB business (***471)');
  assert.equal(mask('short 42'), 'short 42');
});

test('send() is a no-op when no bot token or chat id is configured', async () => {
  const { bot, calls } = makeBot({ getBotToken: () => '', getChatId: () => '' });
  const result = await bot.send('hello');
  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test('send() posts Markdown first, falling back to plain text if Telegram rejects it', async () => {
  const { bot, calls } = makeBot({
    fetchFn: async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      if (body.parse_mode === 'Markdown') return jsonResponse({ ok: false, description: 'bad markdown' });
      return jsonResponse({ ok: true, result: { message_id: 1 } });
    },
  });
  const r = await bot.send('*unbalanced');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parse_mode, 'Markdown');
  assert.equal(calls[1].parse_mode, undefined);
  assert.equal(r.ok, true);
});

test('handleUpdate silently ignores and logs messages from any chat other than the locked one', async () => {
  let onTextCalled = false;
  const { bot, logs } = makeBot({ onText: async () => { onTextCalled = true; } });
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 999 }, message_id: 1, text: 'hi' } });
  assert.equal(onTextCalled, false);
  assert.equal(logs[0].event, 'telegram_ignored');
  assert.equal(logs[0].data.chatId, '999');
});

test('handleUpdate routes a text message from the locked chat to onText', async () => {
  let received = null;
  const { bot } = makeBot({ onText: async (text, ctx) => { received = { text, ctx }; } });
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 111 }, message_id: 42, text: 'status' } });
  assert.equal(received.text, 'status');
  assert.equal(received.ctx.chatId, '111');
  assert.equal(received.ctx.messageId, 42);
});

test('handleUpdate routes a photo message from the locked chat to onPhoto', async () => {
  let received = null;
  const { bot } = makeBot({ onPhoto: async (photo, ctx) => { received = { photo, ctx }; } });
  await bot.handleUpdate({
    update_id: 1,
    message: { chat: { id: 111 }, message_id: 5, photo: [{ file_id: 'small' }, { file_id: 'large' }] },
  });
  assert.equal(received.photo.fileId, 'large');
  assert.equal(received.ctx.chatId, '111');
});

test('handleUpdate catches a throwing onText, logs it, and sends an error notice instead of crashing', async () => {
  const sent = [];
  const { bot, logs } = makeBot({
    onText: async () => { throw new Error('boom'); },
    fetchFn: async (url, opts) => { sent.push(JSON.parse(opts.body)); return jsonResponse({ ok: true }); },
  });
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 111 }, message_id: 1, text: 'hi' } });
  assert.equal(logs.some(l => l.event === 'telegram_error'), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /audit log/);
});

test('poll() advances the offset and processes each returned update in order', async () => {
  const seen = [];
  const { bot } = makeBot({
    onText: async (text) => { seen.push(text); },
    fetchFn: async () => jsonResponse({
      ok: true,
      result: [
        { update_id: 5, message: { chat: { id: 111 }, message_id: 1, text: 'first' } },
        { update_id: 6, message: { chat: { id: 111 }, message_id: 2, text: 'second' } },
      ],
    }),
  });
  await bot.poll();
  assert.deepEqual(seen, ['first', 'second']);
  assert.equal(bot.state.offset, 7);
});

test('poll() skips a concurrent call while one is already in flight', async () => {
  let inFlight = 0, maxInFlight = 0;
  const { bot } = makeBot({
    fetchFn: async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return jsonResponse({ ok: true, result: [] });
    },
  });
  await Promise.all([bot.poll(), bot.poll()]);
  assert.equal(maxInFlight, 1);
});

test('poll() does nothing when no bot token is configured', async () => {
  const { bot, calls } = makeBot({ getBotToken: () => '' });
  await bot.poll();
  assert.equal(calls.length, 0);
});

test('getFile resolves the Telegram file path then downloads the bytes', async () => {
  const { bot } = makeBot({
    fetchFn: async (url) => {
      if (url.includes('getFile')) return jsonResponse({ ok: true, result: { file_path: 'photos/x.jpg' } });
      return jsonResponse({});
    },
  });
  const file = await bot.getFile('abc');
  assert.equal(file.filePath, 'photos/x.jpg');
  assert.ok(Buffer.isBuffer(file.bytes));
});

test('getFile returns null when Telegram cannot resolve the file id', async () => {
  const { bot } = makeBot({ fetchFn: async () => jsonResponse({ ok: false }) });
  const file = await bot.getFile('missing');
  assert.equal(file, null);
});
