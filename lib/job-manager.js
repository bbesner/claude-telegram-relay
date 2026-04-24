// v1.8.0: background-job registry.
//
// A "job" is a Claude invocation that was started via /run and is allowed to
// outlive a single synchronous Telegram request. Jobs are durable: their
// subprocess is spawned detached, stdout goes to a file under
// ~/.claude-telegram-relay/jobs/, and a small JSON registry tracks state so
// that even if the relay (pm2) restarts we can tell the user what happened.
//
// This module owns JUST the registry (CRUD, persistence, state transitions).
// Actual subprocess lifecycle lives in lib/job-runner.js.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

const STATE_DIR = path.join(process.env.HOME || '/tmp', '.claude-telegram-relay');
const JOBS_FILE = path.join(STATE_DIR, 'jobs.json');
const JOBS_OUTPUT_DIR = path.join(STATE_DIR, 'jobs');

// Valid state transitions. Kept intentionally linear — no "resumed" jobs in v1.
const STATES = Object.freeze({
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  timed_out: 'timed_out',
  cancelled: 'cancelled',
  orphaned: 'orphaned',   // parent restarted and child was already dead with no result
});

let jobs = {}; // jobId -> job record

function load() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(JOBS_OUTPUT_DIR, { recursive: true });
    if (fs.existsSync(JOBS_FILE)) {
      jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
      log.info('Jobs registry loaded', { count: Object.keys(jobs).length });
    }
  } catch (e) {
    log.warn('Failed to load jobs registry, starting fresh', { error: e.message });
    jobs = {};
  }
}

function save() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = JOBS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
    fs.renameSync(tmp, JOBS_FILE);
  } catch (e) {
    log.error('Failed to save jobs registry', { error: e.message });
  }
}

/**
 * Returns a short, human-friendly id. Six hex chars is enough for collision-
 * free uniqueness across thousands of jobs per user; short enough to tap on
 * a phone without mistakes.
 */
function newJobId() {
  for (let i = 0; i < 10; i++) {
    const id = 'job_' + crypto.randomBytes(3).toString('hex');
    if (!jobs[id]) return id;
  }
  // Fallback — extremely unlikely to reach this
  return 'job_' + Date.now().toString(36);
}

/**
 * Create a new job record in state=queued. The caller (job-runner) is
 * responsible for transitioning to running once spawn succeeds. Returns the
 * job record.
 */
function createJob({ chatKey, chatId, sessionId, model, promptPreview, workingDir }) {
  const jobId = newJobId();
  const now = new Date().toISOString();
  const outputPath = path.join(JOBS_OUTPUT_DIR, jobId + '.jsonl');
  jobs[jobId] = {
    jobId,
    chatKey,
    chatId,
    sessionId: sessionId || null,
    model: model || null,
    workingDir: workingDir || null,
    promptPreview: (promptPreview || '').slice(0, 200),
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    state: STATES.queued,
    pid: null,
    outputPath,
    result: null,
    error: null,
    cost: null,
    durationMs: null,
    toolsUsed: [],
    lastStatus: null,       // last status phrase from the streaming renderer
    cancelRequested: false,
  };
  save();
  return jobs[jobId];
}

/**
 * Mark a queued job as running. Stamps pid + startedAt.
 */
function markRunning(jobId, pid) {
  const job = jobs[jobId];
  if (!job) return null;
  job.state = STATES.running;
  job.pid = pid;
  job.startedAt = new Date().toISOString();
  save();
  return job;
}

/**
 * Mark a job as complete. Stamps finishedAt, result, cost, durationMs,
 * toolsUsed. Used on the happy path after the result event arrives.
 */
function markCompleted(jobId, { result, cost, durationMs, toolsUsed, sessionId }) {
  const job = jobs[jobId];
  if (!job) return null;
  job.state = STATES.completed;
  job.finishedAt = new Date().toISOString();
  job.result = result || null;
  job.cost = typeof cost === 'number' ? cost : null;
  job.durationMs = typeof durationMs === 'number' ? durationMs : null;
  job.toolsUsed = Array.isArray(toolsUsed) ? toolsUsed.slice() : [];
  if (sessionId) job.sessionId = sessionId;
  save();
  return job;
}

function markFailed(jobId, error, { state = STATES.failed } = {}) {
  const job = jobs[jobId];
  if (!job) return null;
  job.state = state;
  job.finishedAt = new Date().toISOString();
  job.error = (error && String(error).slice(0, 400)) || 'unknown error';
  save();
  return job;
}

/**
 * Record a status update during the run — used by job-runner as the stream
 * progresses. Shown in /job <id> output.
 */
function setStatus(jobId, lastStatus) {
  const job = jobs[jobId];
  if (!job) return null;
  job.lastStatus = lastStatus;
  // don't save on every tick — status is purely diagnostic
  return job;
}

function appendTool(jobId, toolName) {
  const job = jobs[jobId];
  if (!job || !toolName) return;
  if (!job.toolsUsed.includes(toolName)) {
    job.toolsUsed.push(toolName);
  }
}

function requestCancel(jobId) {
  const job = jobs[jobId];
  if (!job) return null;
  job.cancelRequested = true;
  save();
  return job;
}

function getJob(jobId) {
  return jobs[jobId] || null;
}

function getJobsForChat(chatKey, { limit = 10, includeFinished = true } = {}) {
  const list = Object.values(jobs)
    .filter(j => j.chatKey === chatKey)
    .filter(j => includeFinished || !isTerminal(j.state))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return list.slice(0, limit);
}

function getActiveJobForChat(chatKey) {
  return Object.values(jobs).find(j =>
    j.chatKey === chatKey && !isTerminal(j.state)
  ) || null;
}

/**
 * Used for startup reconciliation — surfaces every job that was running when
 * the relay last shut down so job-runner can decide what to do with each.
 */
function getRunningJobs() {
  return Object.values(jobs).filter(j => j.state === STATES.running || j.state === STATES.queued);
}

function isTerminal(state) {
  return state === STATES.completed
      || state === STATES.failed
      || state === STATES.timed_out
      || state === STATES.cancelled
      || state === STATES.orphaned;
}

/**
 * Drop jobs older than retentionHours. Keeps active jobs regardless of age.
 * Called at load time and occasionally afterwards.
 */
function gc(retentionHours = 168) {
  const cutoff = Date.now() - retentionHours * 3600 * 1000;
  let removed = 0;
  for (const [id, job] of Object.entries(jobs)) {
    if (!isTerminal(job.state)) continue;
    const when = new Date(job.finishedAt || job.createdAt).getTime();
    if (isFinite(when) && when < cutoff) {
      try { if (job.outputPath && fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath); } catch { /* ignore */ }
      delete jobs[id];
      removed++;
    }
  }
  if (removed > 0) {
    save();
    log.info('Jobs GC', { removed, remaining: Object.keys(jobs).length });
  }
  return removed;
}

// Load on require
load();

module.exports = {
  STATES,
  createJob,
  markRunning,
  markCompleted,
  markFailed,
  setStatus,
  appendTool,
  requestCancel,
  getJob,
  getJobsForChat,
  getActiveJobForChat,
  getRunningJobs,
  isTerminal,
  gc,
  // test-only access
  _reload: () => load(),
};
