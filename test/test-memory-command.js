// Tests that /memory is ONLY registered in commands.js when OpenClaw is
// detected, and that when registered it routes to searchMemory correctly.
// Uses a fixture HOME with a fake openclaw.json + a mocked spawn.

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const EventEmitter = require('events');

let mockSpawn = null;
let capturedSpawn = [];

const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'child_process') {
    return {
      spawn(binary, args, opts) {
        capturedSpawn.push({ binary, args, opts });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        const b = mockSpawn || { code: 0, stdout: '{"results":[]}' };
        setImmediate(() => {
          if (b.stdout) child.stdout.emit('data', Buffer.from(b.stdout));
          child.emit('close', b.code);
        });
        return child;
      },
    };
  }
  return origLoad.apply(this, [request, parent, ...rest]);
};

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// --- Setup fixture HOME with a fake openclaw.json so detection succeeds ---
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mc-'));
fs.mkdirSync(path.join(SCRATCH, '.openclaw'), { recursive: true });
fs.writeFileSync(path.join(SCRATCH, '.openclaw', 'openclaw.json'), '{}');
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'error';

// Require commands AFTER HOME is set so detection picks up our fake config
const { registerCommands, isOpenclawAvailable } = require('../lib/commands');

console.log('\n=== /memory wiring ===');
ok('isOpenclawAvailable() returns true with fake config', isOpenclawAvailable() === true);

// Register commands against a mock bot
const handlers = [];
const sent = [];
const mockBot = {
  onText: (regex, handler) => handlers.push({ regex, handler }),
  sendMessage: (chatId, text, opts) => { sent.push({ chatId, text, opts }); return Promise.resolve(); },
  sendChatAction: () => Promise.resolve(),
};
registerCommands(mockBot);

const memoryHandler = handlers.find(h => String(h.regex).includes('memory'));
ok('/memory handler registered when OpenClaw detected', memoryHandler !== undefined);

function fire(text, userId = 777) {
  const msg = { chat: { id: userId, type: 'private' }, from: { id: userId }, text };
  const m = text.match(memoryHandler.regex);
  return memoryHandler.handler(msg, m);
}

(async () => {
  // No arg → usage message
  sent.length = 0;
  capturedSpawn.length = 0;
  await fire('/memory');
  ok('/memory with no arg shows usage',
     sent.length === 1 && sent[0].text.includes('Usage'));
  ok('/memory with no arg does NOT spawn openclaw',
     capturedSpawn.length === 0);

  // With query → spawns openclaw and renders results
  sent.length = 0;
  capturedSpawn.length = 0;
  mockSpawn = {
    code: 0,
    stdout: JSON.stringify({
      results: [
        { path: 'memory/today.md', startLine: 1, endLine: 5, score: 0.9, snippet: 'Important fact' },
      ],
    }),
  };
  await fire('/memory sck migration');
  ok('/memory <query> spawns openclaw', capturedSpawn.length === 1);

  const call = capturedSpawn[0];
  ok('spawn binary is openclaw', call.binary === 'openclaw');
  ok('spawn args include memory + search',
     call.args.includes('memory') && call.args.includes('search'));
  ok('spawn args include the query verbatim',
     call.args.includes('sck migration'));
  ok('spawn args include --json', call.args.includes('--json'));
  ok('spawn cwd is the config dir',
     call.opts.cwd === path.join(SCRATCH, '.openclaw'));

  // Give the async handler a moment to send its response
  await new Promise(r => setTimeout(r, 50));
  ok('/memory reply was sent', sent.length === 1);
  ok('reply includes snippet',   sent[0].text.includes('Important fact'));
  ok('reply formatted as HTML',  sent[0].opts?.parse_mode === 'HTML');

  // openclaw error path
  sent.length = 0;
  capturedSpawn.length = 0;
  mockSpawn = { code: 1, stderr: undefined, stdout: '' };
  await fire('/memory some query');
  await new Promise(r => setTimeout(r, 50));
  ok('openclaw error produces a user-facing error message',
     sent.length === 1 && /failed/i.test(sent[0].text));

  // Cleanup
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\nmemory-command: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
