const { spawn } = require('child_process');
const { execSync } = require('child_process');
const log = require('./logger');

// Auto-detect claude binary path
function findClaude() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  try {
    return execSync('which claude', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Claude CLI not found. Set CLAUDE_PATH or ensure claude is in PATH.');
  }
}

let claudePath;
try {
  claudePath = findClaude();
  log.info('Claude CLI found', { path: claudePath });
} catch (e) {
  log.error('Claude CLI not found', { error: e.message });
  process.exit(1);
}

// v1.6.0: active in-flight child processes, keyed by chatKey so /interrupt
// can target exactly the running job for the chat that asked to cancel it.
// We keep the timer reference too so interrupt can clear it and resolve
// without racing the normal timeout path.
const ACTIVE = new Map();

/**
 * Invoke Claude Code CLI in headless mode.
 * @param {string} prompt - The user's message
 * @param {object} options
 * @param {string} [options.sessionId] - Session ID to resume
 * @param {string} [options.model] - Model override
 * @param {string} [options.workingDir] - Working directory for claude
 * @param {number} [options.timeout] - Timeout in ms
 * @param {string} [options.chatKey] - If provided, register the subprocess
 *        in the ACTIVE map so it can be interrupted by chat key.
 * @returns {Promise<{result, sessionId, cost, error, timedOut, interrupted}>}
 */
function invokeClaude(prompt, options = {}) {
  const {
    sessionId,
    model,
    workingDir = process.env.WORKING_DIR || process.env.HOME,
    timeout = parseInt(process.env.CLAUDE_TIMEOUT_MS || '120000', 10),
    chatKey,
  } = options;

  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json'];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    if (model) {
      args.push('--model', model);
    }

    log.debug('Spawning claude', { args, cwd: workingDir, promptLength: prompt.length });

    const child = spawn(claudePath, args, {
      cwd: workingDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let interrupted = false;

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    // Write prompt via stdin to avoid shell escaping issues
    child.stdin.write(prompt);
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn('Claude subprocess timeout kill', { chatKey, sessionId: sessionId?.slice(0, 8), timeoutMs: timeout });
      child.kill('SIGTERM');
      // Give it a moment to clean up, then force kill
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    }, timeout);

    // v1.6.0: register so /interrupt can find and kill this subprocess.
    const entry = {
      child,
      sessionId,
      startedAt: Date.now(),
      interrupt() {
        if (interrupted) return false;
        interrupted = true;
        log.info('Claude subprocess interrupted by user', { chatKey, sessionId: sessionId?.slice(0, 8) });
        try { child.kill('SIGTERM'); } catch { /* process already gone */ }
        setTimeout(() => {
          if (!child.killed) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
        }, 3000);
        return true;
      },
    };
    if (chatKey) ACTIVE.set(chatKey, entry);

    const cleanup = () => {
      clearTimeout(timer);
      if (chatKey && ACTIVE.get(chatKey) === entry) ACTIVE.delete(chatKey);
    };

    child.on('close', (code) => {
      cleanup();

      // Try to parse JSON response
      try {
        const json = JSON.parse(stdout);
        if (json.is_error) {
          resolve({
            result: null,
            sessionId: json.session_id || sessionId,
            cost: json.total_cost_usd || null,
            error: json.result || 'Claude returned an error',
            timedOut,
            interrupted,
          });
        } else {
          resolve({
            result: json.result || '',
            sessionId: json.session_id || sessionId,
            cost: json.total_cost_usd || null,
            error: null,
            timedOut,
            interrupted,
          });
        }
      } catch {
        // JSON parse failed — fall back to raw output
        if (code !== 0 || !stdout.trim()) {
          let errMsg;
          if (interrupted) {
            errMsg = 'interrupted by user';
          } else if (timedOut) {
            errMsg = `timed out after ${Math.round(timeout / 1000)}s`;
          } else {
            errMsg = stderr.trim() || `Claude exited with code ${code}`;
          }
          resolve({
            result: null,
            sessionId,
            cost: null,
            error: errMsg,
            timedOut,
            interrupted,
          });
        } else {
          // Non-JSON output (shouldn't happen with --output-format json, but handle it)
          resolve({
            result: stdout.trim(),
            sessionId,
            cost: null,
            error: null,
            timedOut,
            interrupted,
          });
        }
      }
    });

    child.on('error', (err) => {
      cleanup();
      resolve({
        result: null,
        sessionId,
        cost: null,
        error: `Failed to spawn claude: ${err.message}`,
        timedOut,
        interrupted,
      });
    });
  });
}

/**
 * v1.6.0: cancel the in-flight Claude subprocess for the given chat, if any.
 * Returns { interrupted: true, sessionId } on success, or { interrupted: false }
 * when nothing was running. The originating invokeClaude() promise still
 * resolves cleanly — it just surfaces `interrupted: true` in the result.
 */
function interruptJob(chatKey) {
  const entry = ACTIVE.get(chatKey);
  if (!entry) return { interrupted: false };
  const ok = entry.interrupt();
  return { interrupted: ok, sessionId: entry.sessionId, elapsedMs: Date.now() - entry.startedAt };
}

/**
 * v1.6.0: for /info and diagnostics — is anything currently running for this chat?
 */
function getActiveJob(chatKey) {
  const entry = ACTIVE.get(chatKey);
  if (!entry) return null;
  return { sessionId: entry.sessionId, startedAt: entry.startedAt, elapsedMs: Date.now() - entry.startedAt };
}

module.exports = { invokeClaude, interruptJob, getActiveJob };
