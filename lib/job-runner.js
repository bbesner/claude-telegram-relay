// v1.8.0: job runner.
//
// Spawns Claude as a detached subprocess for a background job, pipes its
// stream-json output to a file under ~/.claude-telegram-relay/jobs/, watches
// the file for events as they arrive, updates the job record via
// lib/job-manager.js, and fires a completion callback so bot.js can send the
// result back to the originating Telegram chat.
//
// Durability model:
//   - Child is spawned detached with stdout/stderr redirected to a FILE on
//     disk. If the parent dies, the child keeps running and keeps writing.
//   - On the happy path the parent reads events from the file in real time
//     and marks the job completed when it sees a `result` event.
//   - On relay restart, reconcileOnStartup() scans all registry entries in
//     state=running, checks liveness, and either re-attaches a watcher (if
//     the pid is still alive) or finalizes from the file's already-written
//     tail (if the child finished during the outage).
//
// Intentional v1 limitations (documented in CHANGELOG):
//   - One concurrent background job per chat (prevent runaway spawns).
//   - No per-tool permission forwarding — jobs inherit whatever the claude
//     CLI does for headless non-TTY prompts.
//   - No retry / restart of the subprocess itself. If it dies without a
//     `result` event it's marked failed / orphaned and the user is notified.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const log = require('./logger');
const jm = require('./job-manager');

function findClaude() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  try { return execSync('which claude', { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

// Per-job bookkeeping — kept in-memory; not persisted. Holds the file watcher
// + parser state so we can stop cleanly on cancel / completion.
const ACTIVE_WATCHERS = new Map(); // jobId -> { watcher, pollTimer, offset, buffer, onEventSinks }

/**
 * Start a new background job. Returns the job record immediately — the
 * caller can show the jobId to the user right away; completion is delivered
 * via onComplete.
 *
 * @param {object} args
 * @param {string} args.prompt
 * @param {string} args.chatKey
 * @param {number|string} args.chatId
 * @param {string} [args.sessionId]
 * @param {string} [args.model]
 * @param {string} [args.workingDir]
 * @param {number} [args.timeoutMs]
 * @param {function(job)} [args.onComplete] — fired with the final job record
 *        (state=completed|failed|timed_out|cancelled|orphaned). Exactly once.
 */
function startJob(args) {
  const claudePath = findClaude();
  if (!claudePath) {
    const fail = jm.markFailed(
      jm.createJob({
        chatKey: args.chatKey,
        chatId: args.chatId,
        sessionId: args.sessionId,
        model: args.model,
        promptPreview: args.prompt || '',
        workingDir: args.workingDir,
      }).jobId,
      'Claude CLI not found'
    );
    if (args.onComplete) setImmediate(() => args.onComplete(fail));
    return fail;
  }

  const job = jm.createJob({
    chatKey: args.chatKey,
    chatId: args.chatId,
    sessionId: args.sessionId,
    model: args.model,
    promptPreview: args.prompt || '',
    workingDir: args.workingDir,
  });

  const cliArgs = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (args.sessionId) cliArgs.push('--resume', args.sessionId);
  if (args.model)     cliArgs.push('--model', args.model);

  // Open the output file for the subprocess's stdout/stderr. Truncate in
  // case a previous partial write left garbage.
  let outFd;
  try {
    outFd = fs.openSync(job.outputPath, 'w');
  } catch (e) {
    jm.markFailed(job.jobId, `Could not open job output file: ${e.message}`);
    if (args.onComplete) setImmediate(() => args.onComplete(jm.getJob(job.jobId)));
    return jm.getJob(job.jobId);
  }

  const child = spawn(claudePath, cliArgs, {
    cwd: args.workingDir || process.env.WORKING_DIR || process.env.HOME,
    env: { ...process.env },
    stdio: ['pipe', outFd, outFd],
    detached: true,
  });

  // Write the prompt to stdin then close it.
  try {
    child.stdin.write(args.prompt || '');
    child.stdin.end();
  } catch (e) {
    log.warn('job-runner: stdin write failed', { jobId: job.jobId, error: e.message });
  }

  // Let the parent die without SIGHUPing the child.
  child.unref();

  // Close our copy of the output fd — the child holds its own duplicate.
  try { fs.closeSync(outFd); } catch { /* ignore */ }

  jm.markRunning(job.jobId, child.pid);
  log.info('Background job started', {
    jobId: job.jobId,
    pid: child.pid,
    chatKey: args.chatKey,
    sessionId: args.sessionId?.slice(0, 8),
  });

  // Wall-clock timeout. If we hit it, send SIGTERM; file watcher will finalize.
  const timeoutMs = args.timeoutMs || parseInt(process.env.JOB_TIMEOUT_MS || '3600000', 10);
  const timeoutTimer = setTimeout(() => {
    log.warn('job-runner: wall-clock timeout', { jobId: job.jobId, pid: child.pid, timeoutMs });
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
    // Escalate after a grace period
    setTimeout(() => {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, 10000);
  }, timeoutMs);

  // Attach the output watcher. It's responsible for calling onComplete.
  attachWatcher(job.jobId, {
    onComplete: (finalJob) => {
      clearTimeout(timeoutTimer);
      if (args.onComplete) args.onComplete(finalJob);
    },
  });

  return jm.getJob(job.jobId);
}

/**
 * Watch a job's output file and drive state/completion. Can be called either
 * from startJob (fresh watch) or from reconcileOnStartup (resumed watch after
 * a relay restart).
 */
function attachWatcher(jobId, { onComplete }) {
  const job = jm.getJob(jobId);
  if (!job) return;
  if (ACTIVE_WATCHERS.has(jobId)) {
    // Already watching — just add the sink
    ACTIVE_WATCHERS.get(jobId).onCompleteSinks.push(onComplete);
    return;
  }

  const state = {
    offset: 0,
    buffer: '',
    saw: {
      finalText: null,
      cost: null,
      durationMs: null,
      sessionId: job.sessionId,
      isError: null,
      errorText: null,
    },
    onCompleteSinks: onComplete ? [onComplete] : [],
    pollTimer: null,
    finalized: false,
  };

  ACTIVE_WATCHERS.set(jobId, state);

  const finalize = (terminalState, errorText) => {
    if (state.finalized) return;
    state.finalized = true;
    let finalJob;
    if (terminalState === jm.STATES.completed) {
      finalJob = jm.markCompleted(jobId, {
        result: state.saw.finalText,
        cost: state.saw.cost,
        durationMs: state.saw.durationMs,
        toolsUsed: jm.getJob(jobId).toolsUsed,
        sessionId: state.saw.sessionId,
      });
    } else {
      finalJob = jm.markFailed(jobId, errorText, { state: terminalState });
    }
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    ACTIVE_WATCHERS.delete(jobId);
    for (const sink of state.onCompleteSinks) {
      try { sink(finalJob); } catch (e) { log.warn('onComplete sink threw', { error: e.message }); }
    }
  };

  const handleEvent = (evt) => {
    if (evt.session_id && !state.saw.sessionId) state.saw.sessionId = evt.session_id;

    switch (evt.type) {
      case 'assistant': {
        const content = evt.message?.content;
        if (!Array.isArray(content)) return;
        for (const c of content) {
          if (c?.type === 'tool_use' && c.name) {
            jm.appendTool(jobId, c.name);
            jm.setStatus(jobId, `Using ${c.name}`);
          } else if (c?.type === 'thinking') {
            jm.setStatus(jobId, 'Thinking…');
          } else if (c?.type === 'text' && typeof c.text === 'string') {
            state.saw.finalText = c.text;
            jm.setStatus(jobId, 'Replying…');
          }
        }
        return;
      }
      case 'result': {
        state.saw.finalText = typeof evt.result === 'string' ? evt.result : state.saw.finalText;
        state.saw.cost = typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : state.saw.cost;
        state.saw.durationMs = typeof evt.duration_ms === 'number' ? evt.duration_ms : state.saw.durationMs;
        state.saw.isError = !!evt.is_error;
        if (evt.is_error) {
          state.saw.errorText = (typeof evt.result === 'string' && evt.result) ||
                                evt.api_error_status || 'Claude returned an error';
          finalize(jm.STATES.failed, state.saw.errorText);
        } else {
          finalize(jm.STATES.completed);
        }
        return;
      }
      case 'system':
      case 'user':
      case 'rate_limit_event':
      default:
        return;
    }
  };

  const readChunk = () => {
    if (state.finalized) return;
    let stat;
    try { stat = fs.statSync(job.outputPath); } catch { return; }
    if (stat.size <= state.offset) return;

    let fd;
    try { fd = fs.openSync(job.outputPath, 'r'); } catch { return; }
    const len = stat.size - state.offset;
    const buf = Buffer.alloc(len);
    try {
      fs.readSync(fd, buf, 0, len, state.offset);
      state.offset = stat.size;
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    state.buffer += buf.toString('utf8');

    let nl;
    while ((nl = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, nl);
      state.buffer = state.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try { handleEvent(JSON.parse(line)); }
      catch (e) { log.debug('job-runner: unparseable line', { jobId, error: e.message }); }
    }
  };

  const checkLiveness = () => {
    if (state.finalized) return;
    const current = jm.getJob(jobId);
    if (!current) { finalize(jm.STATES.failed, 'job record disappeared'); return; }
    if (current.cancelRequested && current.pid) {
      try { process.kill(current.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    if (!current.pid) return;
    let alive = false;
    try { process.kill(current.pid, 0); alive = true; }
    catch (e) { alive = false; }
    if (!alive) {
      // Flush remaining file content before finalizing
      readChunk();
      if (state.finalized) return;
      if (state.saw.finalText && !state.saw.isError) {
        finalize(jm.STATES.completed);
      } else if (current.cancelRequested) {
        finalize(jm.STATES.cancelled, 'cancelled by user');
      } else {
        finalize(jm.STATES.orphaned, state.saw.errorText || 'subprocess exited without a result event');
      }
    }
  };

  // Poll the file + liveness once per second. fs.watch would be cheaper but
  // is unreliable across filesystems (NFS, some EC2 setups). A 1s poll is
  // plenty for background-job UX and keeps the implementation portable.
  state.pollTimer = setInterval(() => {
    readChunk();
    checkLiveness();
  }, 1000);
  // Kick it once immediately so reconciliation finalizes fast.
  setImmediate(() => { readChunk(); checkLiveness(); });
}

/**
 * Startup reconciliation. For each registry entry in state=running, decide
 * what to do. Must be called once at bot.js startup, before any new jobs are
 * spawned.
 *
 * @param {function(job)} onResume — called for each job that is re-attached
 *        (child still alive). Good time to tell the user "still running".
 * @param {function(job)} onComplete — called for each job that is finalized
 *        during reconciliation. Good time to deliver the belated result.
 */
function reconcileOnStartup({ onResume, onComplete } = {}) {
  const running = jm.getRunningJobs();
  if (running.length === 0) return { reAttached: 0, finalized: 0 };
  log.info('job-runner: reconciling running jobs', { count: running.length });
  let reAttached = 0;
  let finalized = 0;
  for (const job of running) {
    attachWatcher(job.jobId, {
      onComplete: (finalJob) => {
        finalized++;
        if (onComplete) onComplete(finalJob);
      },
    });
    // If the pid is still alive we notify resume; otherwise the watcher will
    // finalize on the first liveness check (within a second) and fire
    // onComplete instead.
    let alive = false;
    if (job.pid) {
      try { process.kill(job.pid, 0); alive = true; } catch { alive = false; }
    }
    if (alive) {
      reAttached++;
      if (onResume) onResume(job);
    }
  }
  return { reAttached, finalized };
}

/**
 * Cancel a running job. Best-effort: sets the cancel flag so the watcher's
 * liveness check will SIGTERM on the next tick, and also sends SIGTERM
 * directly if we still have the pid. Returns true if the job existed and
 * wasn't already terminal.
 */
function cancelJob(jobId) {
  const job = jm.getJob(jobId);
  if (!job) return false;
  if (jm.isTerminal(job.state)) return false;
  jm.requestCancel(jobId);
  if (job.pid) {
    try { process.kill(job.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  return true;
}

module.exports = {
  startJob,
  cancelJob,
  reconcileOnStartup,
  attachWatcher,
  // test-only
  _hasWatcher: (jobId) => ACTIVE_WATCHERS.has(jobId),
  _stopAllWatchers: () => {
    for (const [id, state] of ACTIVE_WATCHERS.entries()) {
      if (state.pollTimer) clearInterval(state.pollTimer);
      ACTIVE_WATCHERS.delete(id);
    }
  },
};
