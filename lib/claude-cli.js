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

/**
 * Invoke Claude Code CLI in headless mode.
 * @param {string} prompt - The user's message
 * @param {object} options
 * @param {string} [options.sessionId] - Session ID to resume
 * @param {string} [options.model] - Model override
 * @param {string} [options.workingDir] - Working directory for claude
 * @param {number} [options.timeout] - Timeout in ms
 * @returns {Promise<{result: string, sessionId: string, cost: number, error: string|null}>}
 */
function invokeClaude(prompt, options = {}) {
  const {
    sessionId,
    model,
    workingDir = process.env.WORKING_DIR || process.env.HOME,
    timeout = parseInt(process.env.CLAUDE_TIMEOUT_MS || '120000', 10),
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

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    // Write prompt via stdin to avoid shell escaping issues
    child.stdin.write(prompt);
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // Give it a moment to clean up, then force kill
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
      resolve({
        result: null,
        sessionId: null,
        cost: null,
        error: `Request timed out after ${Math.round(timeout / 1000)}s`,
      });
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);

      // Try to parse JSON response
      try {
        const json = JSON.parse(stdout);
        if (json.is_error) {
          resolve({
            result: null,
            sessionId: json.session_id || sessionId,
            cost: json.total_cost_usd || null,
            error: json.result || 'Claude returned an error',
          });
        } else {
          resolve({
            result: json.result || '',
            sessionId: json.session_id || sessionId,
            cost: json.total_cost_usd || null,
            error: null,
          });
        }
      } catch {
        // JSON parse failed — fall back to raw output
        if (code !== 0 || !stdout.trim()) {
          resolve({
            result: null,
            sessionId,
            cost: null,
            error: stderr.trim() || `Claude exited with code ${code}`,
          });
        } else {
          // Non-JSON output (shouldn't happen with --output-format json, but handle it)
          resolve({
            result: stdout.trim(),
            sessionId,
            cost: null,
            error: null,
          });
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        result: null,
        sessionId,
        cost: null,
        error: `Failed to spawn claude: ${err.message}`,
      });
    });
  });
}

module.exports = { invokeClaude };
