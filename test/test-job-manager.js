// v1.8.0: exercise lib/job-manager.js registry against a scratch HOME.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-jm-'));
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'warn';

delete require.cache[require.resolve('../lib/job-manager')];
const jm = require('../lib/job-manager');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// ---- createJob ----
const j = jm.createJob({
  chatKey: 'user:100',
  chatId: 100,
  sessionId: 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  model: 'sonnet',
  promptPreview: 'hello background',
  workingDir: '/tmp',
});
ok('createJob returns a record',             typeof j === 'object');
ok('job id looks like job_xxxxxx',           /^job_[0-9a-f]{6}$/.test(j.jobId));
ok('state starts queued',                    j.state === jm.STATES.queued);
ok('outputPath under jobs/',                 /\/jobs\/job_[0-9a-f]{6}\.jsonl$/.test(j.outputPath));
ok('promptPreview preserved',                j.promptPreview === 'hello background');
ok('toolsUsed initialized []',               Array.isArray(j.toolsUsed) && j.toolsUsed.length === 0);
ok('pid null until markRunning',             j.pid === null);

// ---- markRunning ----
jm.markRunning(j.jobId, 9999);
const r = jm.getJob(j.jobId);
ok('markRunning sets state=running',         r.state === jm.STATES.running);
ok('markRunning stamps pid',                 r.pid === 9999);
ok('markRunning stamps startedAt',           typeof r.startedAt === 'string');

// ---- appendTool, setStatus ----
jm.appendTool(j.jobId, 'Read');
jm.appendTool(j.jobId, 'Grep');
jm.appendTool(j.jobId, 'Read'); // dedupe
ok('appendTool collects in order without dupes',
   JSON.stringify(jm.getJob(j.jobId).toolsUsed) === JSON.stringify(['Read', 'Grep']));
jm.setStatus(j.jobId, 'Using Grep');
ok('setStatus sets lastStatus',              jm.getJob(j.jobId).lastStatus === 'Using Grep');

// ---- markCompleted ----
jm.markCompleted(j.jobId, {
  result: 'all done',
  cost: 0.05,
  durationMs: 12345,
  toolsUsed: ['Read', 'Grep'],
  sessionId: 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
});
const c = jm.getJob(j.jobId);
ok('markCompleted sets state=completed',     c.state === jm.STATES.completed);
ok('markCompleted stamps result',            c.result === 'all done');
ok('markCompleted stamps cost',              Math.abs(c.cost - 0.05) < 1e-9);
ok('markCompleted stamps durationMs',        c.durationMs === 12345);
ok('markCompleted stamps finishedAt',        typeof c.finishedAt === 'string');

// ---- isTerminal ----
ok('isTerminal(completed) true',             jm.isTerminal(jm.STATES.completed));
ok('isTerminal(running) false',              !jm.isTerminal(jm.STATES.running));
ok('isTerminal(cancelled) true',             jm.isTerminal(jm.STATES.cancelled));

// ---- one-active-per-chat enforcement helpers ----
const j2 = jm.createJob({ chatKey: 'user:100', chatId: 100, promptPreview: 'second' });
jm.markRunning(j2.jobId, 8888);
const active = jm.getActiveJobForChat('user:100');
ok('getActiveJobForChat returns the running one (not the completed one)',
   active && active.jobId === j2.jobId);
ok('getActiveJobForChat null for other chat',
   jm.getActiveJobForChat('user:999') === null);

// ---- requestCancel + markFailed ----
jm.requestCancel(j2.jobId);
ok('requestCancel flips cancelRequested',    jm.getJob(j2.jobId).cancelRequested === true);
jm.markFailed(j2.jobId, 'SIGTERMed', { state: jm.STATES.cancelled });
ok('markFailed with cancelled state',        jm.getJob(j2.jobId).state === jm.STATES.cancelled);
ok('markFailed records error text',          jm.getJob(j2.jobId).error === 'SIGTERMed');

// ---- getJobsForChat ordering ----
const list = jm.getJobsForChat('user:100', { limit: 10 });
ok('getJobsForChat returns both chat jobs', list.length === 2);
ok('getJobsForChat newest first',
   list[0].createdAt >= list[1].createdAt);

// ---- Persistence: reload and verify state survives ----
delete require.cache[require.resolve('../lib/job-manager')];
const jm2 = require('../lib/job-manager');
ok('persisted job_* survives reload',
   jm2.getJob(j.jobId) && jm2.getJob(j.jobId).state === jm.STATES.completed);
ok('reloaded toolsUsed intact',
   JSON.stringify(jm2.getJob(j.jobId).toolsUsed) === JSON.stringify(['Read', 'Grep']));

// ---- gc drops old terminal jobs ----
// Force one of the jobs to look a week old
const JOBS_FILE = path.join(SCRATCH, '.claude-telegram-relay', 'jobs.json');
const raw = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
raw[j.jobId].finishedAt = new Date(Date.now() - 169 * 3600 * 1000).toISOString();
fs.writeFileSync(JOBS_FILE, JSON.stringify(raw));
delete require.cache[require.resolve('../lib/job-manager')];
const jm3 = require('../lib/job-manager');
jm3.gc(168);
ok('gc removed the ancient completed job',
   jm3.getJob(j.jobId) === null);
ok('gc kept the recent cancelled job',
   jm3.getJob(j2.jobId) !== null);

console.log(`\njob-manager: ${pass} passed, ${fail} failed`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
