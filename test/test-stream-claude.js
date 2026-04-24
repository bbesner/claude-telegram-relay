// v1.7.0: end-to-end test for lib/claude-cli.js:streamClaude using a fake
// "claude" binary that writes a scripted stream-json sequence to stdout
// over several hundred ms. Verifies:
//   - events arrive progressively with correct `kind`
//   - session_id is discovered from the init event
//   - tool_use names are collected into toolsUsed[]
//   - final resolves with { result, cost, sessionId, toolsUsed, interrupted:false }
//   - interrupt while streaming resolves with interrupted: true, non-null sessionId
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-stream-'));
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'warn';
process.env.CLAUDE_TIMEOUT_MS = '60000';

// Fake claude: emits a scripted stream-json sequence over ~600ms so we can
// observe progressive event arrival. Uses node so we get a cross-platform
// sub-second sleep without hardcoding shell tricks.
const fake = path.join(SCRATCH, 'claude');
fs.writeFileSync(fake, `#!/usr/bin/env node
const events = [
  { delay: 50,  json: {type:'system',subtype:'init',cwd:'/tmp',session_id:'fake1111-2222-3333-4444-555555555555',model:'claude-test'} },
  { delay: 100, json: {type:'assistant',message:{content:[{type:'thinking',thinking:'pondering'}]},session_id:'fake1111-2222-3333-4444-555555555555'} },
  { delay: 100, json: {type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{file_path:'/tmp/x.txt'}}]},session_id:'fake1111-2222-3333-4444-555555555555'} },
  { delay: 100, json: {type:'user',message:{content:[{type:'tool_result',content:'ok'}]},session_id:'fake1111-2222-3333-4444-555555555555'} },
  { delay: 100, json: {type:'assistant',message:{content:[{type:'tool_use',name:'Grep',input:{pattern:'foo'}}]},session_id:'fake1111-2222-3333-4444-555555555555'} },
  { delay: 100, json: {type:'user',message:{content:[{type:'tool_result',content:'ok'}]},session_id:'fake1111-2222-3333-4444-555555555555'} },
  { delay: 100, json: {type:'assistant',message:{content:[{type:'text',text:'Here is your answer.'}]},session_id:'fake1111-2222-3333-4444-555555555555'} },
  { delay: 50,  json: {type:'result',subtype:'success',is_error:false,result:'Here is your answer.',session_id:'fake1111-2222-3333-4444-555555555555',total_cost_usd:0.0042,duration_ms:650} },
];
(async () => {
  for (const e of events) {
    await new Promise(r => setTimeout(r, e.delay));
    process.stdout.write(JSON.stringify(e.json) + '\\n');
  }
})();
`);
fs.chmodSync(fake, 0o755);
process.env.CLAUDE_PATH = fake;

const { streamClaude, interruptJob, getActiveJob } = require('../lib/claude-cli');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

(async () => {
  // ---- Scenario 1: full stream, no interrupt ----
  const events = [];
  const t0 = Date.now();
  const res = await streamClaude('ignored', {
    chatKey: 'user:42',
    onEvent: (e) => events.push({ ...e, at: Date.now() - t0 }),
  });

  ok('emitted init event',       events.some(e => e.kind === 'init' && e.sessionId === 'fake1111-2222-3333-4444-555555555555'));
  ok('emitted thinking event',   events.some(e => e.kind === 'thinking'));
  ok('emitted tool_use Read',    events.some(e => e.kind === 'tool_use' && e.toolName === 'Read'));
  ok('emitted tool_result',      events.some(e => e.kind === 'tool_result'));
  ok('emitted tool_use Grep',    events.some(e => e.kind === 'tool_use' && e.toolName === 'Grep'));
  ok('emitted text event',       events.some(e => e.kind === 'text' && /answer/.test(e.text)));
  ok('emitted final event',      events.some(e => e.kind === 'final'));

  // Events must be progressive — init must arrive before final with a
  // visible delay (otherwise we'd be effectively non-streaming).
  const initAt  = events.find(e => e.kind === 'init').at;
  const finalAt = events.find(e => e.kind === 'final').at;
  ok('final arrives after init with measurable delay',
     finalAt - initAt > 300, `init@${initAt} final@${finalAt}`);

  ok('result matches final text',    res.result === 'Here is your answer.');
  ok('session id surfaces',          res.sessionId === 'fake1111-2222-3333-4444-555555555555');
  ok('cost surfaces',                Math.abs(res.cost - 0.0042) < 1e-9);
  ok('toolsUsed captured in order',  JSON.stringify(res.toolsUsed) === JSON.stringify(['Read', 'Grep']));
  ok('no error',                     res.error === null);
  ok('not timed out',                res.timedOut === false);
  ok('not interrupted',              res.interrupted === false);

  // Active job cleaned up after completion
  ok('getActiveJob null after completion', getActiveJob('user:42') === null);

  // ---- Scenario 2: interrupt mid-stream ----
  const eventsB = [];
  const invocation = streamClaude('ignored', {
    chatKey: 'user:43',
    onEvent: (e) => eventsB.push(e),
  });

  // Wait for the init event to actually arrive so sessionId has been
  // discovered before we interrupt. ACTIVE is registered synchronously at
  // spawn — well before any event is parsed — so waiting on getActiveJob
  // alone races the parser.
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      if (eventsB.some(e => e.kind === 'init')) { clearInterval(iv); resolve(); }
    }, 25);
  });

  const r = interruptJob('user:43');
  ok('interruptJob returns interrupted=true',  r.interrupted === true);

  const resB = await invocation;
  ok('invocation resolves with interrupted=true', resB.interrupted === true);
  ok('invocation reports sessionId even after interrupt',
     typeof resB.sessionId === 'string' && resB.sessionId.length > 0);

  // Session id may come from the init event if it arrived before interrupt
  ok('active map cleaned up after interrupt', getActiveJob('user:43') === null);

  console.log(`\nstream-claude: ${pass} passed, ${fail} failed`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('UNCAUGHT', e);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(1);
});
