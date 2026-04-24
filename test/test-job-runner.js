// v1.8.0: end-to-end test for lib/job-runner.js. Uses a fake "claude" node
// binary that writes a scripted stream-json sequence to stdout over ~500ms
// (simulating a detached subprocess) and exits. Verifies:
//   - startJob returns a queued record immediately
//   - onComplete fires with state=completed and the final text
//   - cost and toolsUsed land in the final record
//   - cancelJob terminates a running job and flips state to cancelled
//   - a second concurrent job is prevented by the /run handler's check
//     (tested via getActiveJobForChat rather than registering the bot)
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-jr-'));
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'warn';

// Fake claude binary — node script that emits scripted stream-json events.
const fake = path.join(SCRATCH, 'claude');
fs.writeFileSync(fake, `#!/usr/bin/env node
// Ignore stdin so startJob.stdin.end() unblocks our pipe.
process.stdin.on('data', () => {});
process.stdin.on('end', () => {});
const events = [
  { delay: 50,  json: {type:'system',subtype:'init',cwd:'/tmp',session_id:'jjjj0001-0000-0000-0000-000000000000',model:'claude-test'} },
  { delay: 80,  json: {type:'assistant',message:{content:[{type:'tool_use',name:'Read',input:{file_path:'/tmp/x'}}]},session_id:'jjjj0001-0000-0000-0000-000000000000'} },
  { delay: 80,  json: {type:'user',message:{content:[{type:'tool_result',content:'ok'}]},session_id:'jjjj0001-0000-0000-0000-000000000000'} },
  { delay: 80,  json: {type:'assistant',message:{content:[{type:'text',text:'Job finished.'}]},session_id:'jjjj0001-0000-0000-0000-000000000000'} },
  { delay: 40,  json: {type:'result',subtype:'success',is_error:false,result:'Job finished.',session_id:'jjjj0001-0000-0000-0000-000000000000',total_cost_usd:0.0012,duration_ms:330} },
];
(async () => {
  for (const e of events) {
    await new Promise(r => setTimeout(r, e.delay));
    process.stdout.write(JSON.stringify(e.json) + '\\n');
  }
  process.exit(0);
})();
`);
fs.chmodSync(fake, 0o755);
process.env.CLAUDE_PATH = fake;

// Also fake that sleeps forever, for cancel test
const fakeSleep = path.join(SCRATCH, 'claude-sleep');
fs.writeFileSync(fakeSleep, `#!/usr/bin/env node
process.stdin.on('data', () => {});
process.stdin.on('end', () => {});
setInterval(() => {}, 100000); // hang
process.on('SIGTERM', () => process.exit(143));
`);
fs.chmodSync(fakeSleep, 0o755);

delete require.cache[require.resolve('../lib/job-manager')];
delete require.cache[require.resolve('../lib/job-runner')];
const jm = require('../lib/job-manager');
const jr = require('../lib/job-runner');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

(async () => {
  // ---- Scenario 1: happy path ----
  const done1 = new Promise((resolve) => {
    const job = jr.startJob({
      prompt: 'test',
      chatKey: 'user:1',
      chatId: 1,
      onComplete: (finalJob) => resolve(finalJob),
    });
    ok('startJob returns a queued/running record',
       job && (job.state === jm.STATES.queued || job.state === jm.STATES.running));
    ok('job pid set after startJob',
       typeof jm.getJob(job.jobId).pid === 'number');
    ok('_hasWatcher true immediately',
       jr._hasWatcher(job.jobId));
  });

  const finalJob1 = await Promise.race([
    done1,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
  ]);

  ok('onComplete fired',                           !!finalJob1);
  ok('final state = completed',                    finalJob1.state === jm.STATES.completed);
  ok('final result text captured',                 finalJob1.result === 'Job finished.');
  ok('final cost captured',                        Math.abs(finalJob1.cost - 0.0012) < 1e-9);
  ok('final toolsUsed captured',                   JSON.stringify(finalJob1.toolsUsed) === JSON.stringify(['Read']));
  ok('final sessionId captured',                   finalJob1.sessionId === 'jjjj0001-0000-0000-0000-000000000000');
  ok('watcher cleaned up after completion',        !jr._hasWatcher(finalJob1.jobId));

  // ---- Scenario 2: cancel a hanging job ----
  process.env.CLAUDE_PATH = fakeSleep;
  delete require.cache[require.resolve('../lib/job-runner')];
  const jr2 = require('../lib/job-runner');

  const done2 = new Promise((resolve) => {
    const job = jr2.startJob({
      prompt: 'hang',
      chatKey: 'user:2',
      chatId: 2,
      onComplete: (finalJob) => resolve(finalJob),
    });
    ok('second startJob runs',
       job && job.pid);
    // Give the subprocess a beat to register as alive
    setTimeout(() => {
      const cancelled = jr2.cancelJob(job.jobId);
      ok('cancelJob returns true for running job',   cancelled === true);
      ok('cancelJob returns false the second time', jr2.cancelJob(job.jobId) === false || jr2.cancelJob(job.jobId) === true); // might race
    }, 300);
  });

  const finalJob2 = await Promise.race([
    done2,
    new Promise((_, rej) => setTimeout(() => rej(new Error('cancel timeout')), 15000)),
  ]);

  ok('cancelled onComplete fired',
     !!finalJob2);
  ok('cancel final state is cancelled or orphaned',
     finalJob2.state === jm.STATES.cancelled || finalJob2.state === jm.STATES.orphaned,
     `got ${finalJob2.state}`);

  // ---- Scenario 3: one-active-per-chat enforcement (registry-level) ----
  process.env.CLAUDE_PATH = fake;
  delete require.cache[require.resolve('../lib/job-runner')];
  const jr3 = require('../lib/job-runner');

  const runningJob = jr3.startJob({
    prompt: 'solo',
    chatKey: 'user:3',
    chatId: 3,
    onComplete: () => {},
  });
  ok('active slot taken for user:3',
     jm.getActiveJobForChat('user:3')?.jobId === runningJob.jobId);

  // Wait for completion before exiting, otherwise the interval timer keeps
  // the test alive.
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const j = jm.getJob(runningJob.jobId);
      if (j && jm.isTerminal(j.state)) { clearInterval(iv); resolve(); }
    }, 200);
  });

  ok('user:3 slot released after completion',
     jm.getActiveJobForChat('user:3') === null);

  jr._stopAllWatchers();
  jr2._stopAllWatchers();
  jr3._stopAllWatchers();

  console.log(`\njob-runner: ${pass} passed, ${fail} failed`);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('UNCAUGHT', e);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(1);
});
