// Tests the /export command wiring end-to-end:
// - Active session required (errors otherwise)
// - Renders via session-exporter (we verify it spawns a valid file)
// - Calls sendDocument with the correct fileOptions (contentType, filename)
//
// Uses a scratch HOME with a fake session JSONL so we don't touch real state.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-exp-'));
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'error';

// Seed a fake ~/.claude/projects/ tree with a session JSONL so findSessionFile works.
const SESSION_ID = 'aabbccdd-1111-2222-3333-444444444444';
const bucket = path.join(SCRATCH, '.claude', 'projects', '-tmp-demo');
fs.mkdirSync(bucket, { recursive: true });
fs.writeFileSync(
  path.join(bucket, SESSION_ID + '.jsonl'),
  JSON.stringify({ type: 'user', timestamp: '2026-04-11T10:00:00Z', message: { content: 'hello' } }) + '\n' +
  JSON.stringify({ type: 'assistant', timestamp: '2026-04-11T10:00:05Z', message: { content: [{ type: 'text', text: 'world' }] } }) + '\n'
);

const { registerCommands } = require('../lib/commands');
const sm = require('../lib/session-manager');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// Mock bot with sendDocument that captures its args
const handlers = [];
const sent = [];
const docs = [];
const mockBot = {
  onText: (regex, handler) => handlers.push({ regex, handler }),
  sendMessage: (chatId, text, opts) => {
    sent.push({ chatId, text, opts });
    return Promise.resolve();
  },
  sendChatAction: () => Promise.resolve(),
  sendDocument: (chatId, filePath, options, fileOptions) => {
    docs.push({ chatId, filePath, options, fileOptions });
    return Promise.resolve();
  },
};
registerCommands(mockBot);

const exportHandler = handlers.find(h => String(h.regex).includes('export'));
ok('/export handler registered', exportHandler !== undefined);

function dm(userId) { return { chat: { id: userId, type: 'private' }, from: { id: userId } }; }
function fire(text, userId = 777) {
  const msg = dm(userId);
  msg.text = text;
  const m = text.match(exportHandler.regex);
  return exportHandler.handler(msg, m);
}

(async () => {
  // No session → error message, no document sent
  sent.length = 0;
  docs.length = 0;
  await fire('/export');
  ok('/export with no session replies with an error',
     sent.length === 1 && sent[0].text.includes('No active session'));
  ok('/export with no session does NOT send a document',
     docs.length === 0);

  // Active session → document sent with the right fileOptions
  sm.setSession(dm(777), SESSION_ID);
  sent.length = 0;
  docs.length = 0;
  await fire('/export');
  await new Promise(r => setTimeout(r, 50)); // let the async handler finish

  ok('/export with active session sends one document', docs.length === 1);
  const call = docs[0];
  ok('chatId passed correctly',
     call.chatId === 777);
  ok('caption is present',
     typeof call.options?.caption === 'string' && call.options.caption.includes('aabbccdd'));
  ok('fileOptions.filename ends in .txt',
     call.fileOptions?.filename?.endsWith('.txt'));
  ok('fileOptions.filename includes first 8 chars of session id',
     call.fileOptions?.filename?.includes('aabbccdd'));
  ok('fileOptions.contentType is text/plain (Android-friendly)',
     call.fileOptions?.contentType === 'text/plain');

  // Verify the actual file written by exportSession still exists and has content
  ok('document file path is absolute',
     typeof call.filePath === 'string' && path.isAbsolute(call.filePath));
  ok('document file exists on disk',
     fs.existsSync(call.filePath));
  const contents = fs.readFileSync(call.filePath, 'utf8');
  ok('file contains # header',             contents.includes('# Claude Code Session'));
  ok('file contains user prompt',           contents.includes('hello'));
  ok('file contains assistant response',   contents.includes('world'));

  // Cleanup
  try { fs.unlinkSync(call.filePath); } catch {}
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\nexport-command: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
