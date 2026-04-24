// v1.6.0: verify interruptJob() actually kills the in-flight subprocess and
// that invokeClaude() resolves with { interrupted: true }. Uses /bin/sh -c
// "sleep 10" as a stand-in for the claude binary, via CLAUDE_PATH, so the
// test is fully hermetic and requires no real claude install.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-interrupt-'));
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'warn';

// Install a tiny fake "claude" binary that just sleeps for 10 seconds and
// prints nothing. We kill it before it exits so the output path we care
// about is the "subprocess was SIGTERMed" branch of invokeClaude.
const fakeClaude = path.join(SCRATCH, 'claude');
// exec replaces the shell with sleep, so SIGTERM goes straight to sleep and
// the process exits immediately — mirrors real claude's fast SIGTERM handling.
fs.writeFileSync(fakeClaude, '#!/bin/sh\nexec sleep 10\n');
fs.chmodSync(fakeClaude, 0o755);
process.env.CLAUDE_PATH = fakeClaude;
process.env.CLAUDE_TIMEOUT_MS = '60000';

const { invokeClaude, interruptJob, getActiveJob } = require('../lib/claude-cli');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

(async () => {
  const chatKey = 'user:12345';

  // Kick off a long-running invocation
  const invocation = invokeClaude('any prompt', { chatKey });

  // Give spawn a beat to register
  await new Promise(r => setTimeout(r, 150));

  // getActiveJob should now show the in-flight run
  const active = getActiveJob(chatKey);
  ok('getActiveJob returns an entry while running',  active !== null);
  ok('getActiveJob has elapsedMs >= 0',              active && typeof active.elapsedMs === 'number');

  // Interrupt it
  const result = interruptJob(chatKey);
  ok('interruptJob returns interrupted=true',        result.interrupted === true);
  ok('interruptJob reports elapsedMs',               typeof result.elapsedMs === 'number');

  // The invocation should now resolve quickly (not wait 10s)
  const t0 = Date.now();
  const res = await invocation;
  const elapsed = Date.now() - t0;

  ok('invocation resolves after interrupt (<4s)',    elapsed < 4000, `elapsed=${elapsed}ms`);
  ok('result.interrupted is true',                   res.interrupted === true);
  ok('result.timedOut is false',                     res.timedOut === false);
  ok('result.error mentions interrupt',              (res.error || '').toLowerCase().includes('interrupt'));

  // After completion the ACTIVE map should be empty for this chat
  ok('getActiveJob returns null after cleanup',      getActiveJob(chatKey) === null);

  // Interrupting when nothing is running returns interrupted=false
  const none = interruptJob(chatKey);
  ok('interruptJob on idle chat returns interrupted=false', none.interrupted === false);

  console.log(`\ninterrupt: ${pass} passed, ${fail} failed`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('UNCAUGHT', e);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(1);
});
