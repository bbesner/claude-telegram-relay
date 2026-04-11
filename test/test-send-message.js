// Tests for lib/send-message.js — the v1.3.0 outbound message helper.
// Mocks https.request so nothing hits the real Telegram API.

// Intercept https BEFORE requiring send-message, so the module captures our fake.
const Module = require('module');
const EventEmitter = require('events');

let mockResponses = []; // queue of { status, body, failWith }
let capturedRequests = []; // what the module sent

const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'https') {
    return {
      request(opts, cb) {
        const req = new EventEmitter();
        const bodyChunks = [];
        req.write = (chunk) => bodyChunks.push(chunk.toString());
        req.end = () => {
          const captured = { opts, body: bodyChunks.join('') };
          capturedRequests.push(captured);

          const mock = mockResponses.shift() || {
            status: 200,
            body: { ok: true, result: { message_id: 42 } },
          };

          if (mock.failWith) {
            // Simulate a network-level error
            setImmediate(() => req.emit('error', new Error(mock.failWith)));
            return;
          }

          setImmediate(() => {
            const res = new EventEmitter();
            res.statusCode = mock.status;
            cb(res);
            res.emit('data', Buffer.from(JSON.stringify(mock.body)));
            res.emit('end');
          });
        };
        req.destroy = () => {};
        return req;
      },
    };
  }
  return origLoad.apply(this, [request, parent, ...rest]);
};

const { sendMessage, chunkMessage, getDefaultChatId } = require('../lib/send-message');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

function reset() {
  mockResponses = [];
  capturedRequests = [];
  delete process.env.DEFAULT_CHAT_ID;
  delete process.env.ALLOWED_USER_IDS;
  delete process.env.TELEGRAM_BOT_TOKEN;
}

// ============================================================================
// getDefaultChatId — the 3-level fallback chain
// ============================================================================

console.log('\n=== getDefaultChatId fallback chain ===');

reset();
ok('no env vars → null', getDefaultChatId() === null);

reset();
process.env.ALLOWED_USER_IDS = '123,456,789';
ok('ALLOWED_USER_IDS alone → first entry', getDefaultChatId() === 123);

reset();
process.env.DEFAULT_CHAT_ID = '555';
process.env.ALLOWED_USER_IDS = '123,456';
ok('DEFAULT_CHAT_ID wins over ALLOWED_USER_IDS', getDefaultChatId() === 555);

reset();
process.env.DEFAULT_CHAT_ID = 'nonsense';
process.env.ALLOWED_USER_IDS = '123';
ok('invalid DEFAULT_CHAT_ID falls through to ALLOWED_USER_IDS', getDefaultChatId() === 123);

reset();
process.env.ALLOWED_USER_IDS = 'also-nonsense';
ok('invalid ALLOWED_USER_IDS → null', getDefaultChatId() === null);

reset();
process.env.ALLOWED_USER_IDS = '   42   , 99';
ok('ALLOWED_USER_IDS trims whitespace', getDefaultChatId() === 42);

// Negative chat IDs (groups) must work
reset();
process.env.DEFAULT_CHAT_ID = '-1001234567890';
ok('negative chat ID (group) accepted', getDefaultChatId() === -1001234567890);

// ============================================================================
// chunkMessage — boundary behavior
// ============================================================================

console.log('\n=== chunkMessage boundary behavior ===');

ok('short text returns 1 chunk', chunkMessage('hello').length === 1);
ok('exactly maxLen returns 1 chunk', chunkMessage('a'.repeat(3800)).length === 1);
ok('over maxLen splits',            chunkMessage('a'.repeat(4500)).length >= 2);

// Paragraph-preferred splitting
const withPara = 'a'.repeat(2000) + '\n\n' + 'b'.repeat(2500);
const paraChunks = chunkMessage(withPara);
ok('paragraph boundary used for split', paraChunks.length === 2);
ok('first chunk ends with "a"s only',   /^a+$/.test(paraChunks[0].trim()));
ok('second chunk starts with "b"s',     /^b+$/.test(paraChunks[1].trim()));

// Line boundary when no paragraph available
const withLines = 'a'.repeat(2000) + '\n' + 'b'.repeat(2500);
const lineChunks = chunkMessage(withLines);
ok('line boundary fallback', lineChunks.length === 2);

// Word boundary when no line break
const wordy = ('word '.repeat(1000));
const wordChunks = chunkMessage(wordy);
ok('word-boundary split', wordChunks.length >= 1);
ok('all chunks within limit', wordChunks.every(c => c.length <= 3800));

// Hard cut when no spaces at all (very long token)
const noBreaks = 'x'.repeat(10000);
const noBreakChunks = chunkMessage(noBreaks);
ok('no-space input chunks at hard limit', noBreakChunks.length >= 2);
ok('no-space chunks respect maxLen',      noBreakChunks.every(c => c.length <= 3800));

// Custom max length
const custom = chunkMessage('a'.repeat(300), 100);
ok('custom maxLen honored', custom.every(c => c.length <= 100));
ok('custom maxLen splits count',
   custom.length >= 3,
   `got ${custom.length} chunks of ${custom.map(c=>c.length)}`);

// ============================================================================
// sendMessage — orchestration
// ============================================================================

console.log('\n=== sendMessage orchestration ===');

// Missing token
async function run() {
  reset();
  process.env.ALLOWED_USER_IDS = '123';
  try {
    await sendMessage('hi');
    ok('missing token throws', false, 'should have thrown');
  } catch (e) {
    ok('missing token throws', e.message.includes('TELEGRAM_BOT_TOKEN'));
  }

  // Missing chat ID
  reset();
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  try {
    await sendMessage('hi');
    ok('missing chat ID throws', false, 'should have thrown');
  } catch (e) {
    ok('missing chat ID throws', e.message.includes('chat ID'));
  }

  // Non-string body
  reset();
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.ALLOWED_USER_IDS = '123';
  try {
    await sendMessage(null);
    ok('non-string body throws', false);
  } catch (e) {
    ok('non-string body throws', e.message.includes('required'));
  }

  // Happy path
  reset();
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.ALLOWED_USER_IDS = '123';
  mockResponses = [{ status: 200, body: { ok: true, result: { message_id: 777 } } }];
  const ids = await sendMessage('hello');
  ok('happy path returns array of message_ids', Array.isArray(ids) && ids[0] === 777);
  ok('happy path fired one request', capturedRequests.length === 1);
  const sent = JSON.parse(capturedRequests[0].body);
  ok('chat_id defaulted to 123',     sent.chat_id === 123);
  ok('text forwarded as-is',          sent.text === 'hello');
  ok('no parse_mode by default',      sent.parse_mode === undefined);
  ok('path uses correct token',       capturedRequests[0].opts.path === '/bottok/sendMessage');

  // options.chatId override
  reset();
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.ALLOWED_USER_IDS = '123';
  mockResponses = [{ status: 200, body: { ok: true, result: { message_id: 1 } } }];
  await sendMessage('hi', { chatId: 999 });
  const sentOverride = JSON.parse(capturedRequests[0].body);
  ok('options.chatId overrides default', sentOverride.chat_id === 999);

  // title prepended
  reset();
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.ALLOWED_USER_IDS = '123';
  mockResponses = [{ status: 200, body: { ok: true, result: { message_id: 1 } } }];
  await sendMessage('body text', { title: '*Deploy done*' });
  const sentTitled = JSON.parse(capturedRequests[0].body);
  ok('title prepended with double newline',
     sentTitled.text === '*Deploy done*\n\nbody text');

  // parseMode forwarded
  reset();
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.ALLOWED_USER_IDS = '123';
  mockResponses = [{ status: 200, body: { ok: true, result: { message_id: 1 } } }];
  await sendMessage('**x**', { parseMode: 'Markdown' });
  const sentMd = JSON.parse(capturedRequests[0].body);
  ok('parseMode forwarded', sentMd.parse_mode === 'Markdown');

  // Long message chunked into multiple sequential sends
  reset();
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.ALLOWED_USER_IDS = '123';
  const huge = 'p1\n\n' + 'a'.repeat(3900) + '\n\n' + 'p3';
  mockResponses = [
    { status: 200, body: { ok: true, result: { message_id: 1 } } },
    { status: 200, body: { ok: true, result: { message_id: 2 } } },
  ];
  const multiIds = await sendMessage(huge);
  ok('long message fires multiple requests', capturedRequests.length === 2);
  ok('returns all message_ids',               multiIds.length === 2);
  const firstPart = JSON.parse(capturedRequests[0].body).text;
  const secondPart = JSON.parse(capturedRequests[1].body).text;
  ok('first chunk prefixed [1/2]',  firstPart.startsWith('[1/2] '));
  ok('second chunk prefixed [2/2]', secondPart.startsWith('[2/2] '));

  // Telegram API error body
  reset();
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.ALLOWED_USER_IDS = '123';
  mockResponses = [{ status: 400, body: { ok: false, description: 'chat not found' } }];
  try {
    await sendMessage('hi');
    ok('API error rejects promise', false);
  } catch (e) {
    ok('API error rejects promise', e.message.includes('chat not found'));
  }

  // Network error path
  reset();
  process.env.TELEGRAM_BOT_TOKEN = 'tok';
  process.env.ALLOWED_USER_IDS = '123';
  mockResponses = [{ failWith: 'ECONNREFUSED' }];
  try {
    await sendMessage('hi');
    ok('network error rejects promise', false);
  } catch (e) {
    ok('network error rejects promise', e.message.includes('ECONNREFUSED'));
  }

  // Token override via options
  reset();
  process.env.ALLOWED_USER_IDS = '123';
  mockResponses = [{ status: 200, body: { ok: true, result: { message_id: 1 } } }];
  await sendMessage('hi', { token: 'override-tok' });
  ok('options.token overrides env',
     capturedRequests[0].opts.path === '/botoverride-tok/sendMessage');

  console.log(`\nsend-message: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
