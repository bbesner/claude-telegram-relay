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

/**
 * v1.7.0: streaming variant. Invokes Claude with --output-format stream-json
 * --verbose and calls onEvent() with normalized, UI-friendly events as they
 * arrive. Resolves with the same shape as invokeClaude() so the caller can
 * treat it as a drop-in replacement for non-streaming callers too.
 *
 * Event shapes passed to onEvent({kind, ...}):
 *   init       { sessionId, model, cwd }
 *   thinking   { text }                  (assistant thinking block)
 *   tool_use   { toolName, toolInput }
 *   tool_result{ ok }                    (bare acknowledgement of a tool result)
 *   text       { text }                  (intermediate assistant text chunk)
 *   final      { text, cost, durationMs, toolsUsed, sessionId }
 *   error      { error }
 *
 * The renderer is expected to be idempotent — it may receive many events in
 * rapid succession and must debounce its own Telegram edits.
 *
 * @param {string} prompt
 * @param {object} options — same as invokeClaude, plus onEvent callback
 * @param {function({kind, ...})} [options.onEvent]
 * @returns {Promise<{result, sessionId, cost, error, timedOut, interrupted, toolsUsed}>}
 */
function streamClaude(prompt, options = {}) {
  const {
    sessionId,
    model,
    workingDir = process.env.WORKING_DIR || process.env.HOME,
    timeout = parseInt(process.env.CLAUDE_TIMEOUT_MS || '120000', 10),
    chatKey,
    onEvent = () => {},
  } = options;

  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);
    if (model)     args.push('--model', model);

    log.debug('Spawning claude (streaming)', { args, cwd: workingDir, promptLength: prompt.length });

    const child = spawn(claudePath, args, {
      cwd: workingDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parser state — the CLI emits one JSON object per line; we keep a
    // line buffer so partial reads don't split an event in half.
    let buffer = '';
    let stderr = '';
    let timedOut = false;
    let interrupted = false;

    // Result accumulation
    let discoveredSessionId = sessionId || null;
    let finalText = '';
    let finalCost = null;
    let finalDurationMs = null;
    const toolsUsed = [];
    let hadError = null;

    child.stdout.on('data', (data) => {
      buffer += data.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); }
        catch (e) {
          log.debug('stream-json: unparseable line', { line: line.slice(0, 200), error: e.message });
          continue;
        }
        handleEvent(evt);
      }
    });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.stdin.write(prompt);
    child.stdin.end();

    function emit(kind, payload) {
      try { onEvent({ kind, ...payload }); }
      catch (e) { log.warn('stream onEvent threw', { kind, error: e.message }); }
    }

    function handleEvent(evt) {
      // Always try to discover the session id as early as possible so the
      // renderer can display it in the seed message.
      if (evt.session_id && !discoveredSessionId) discoveredSessionId = evt.session_id;

      switch (evt.type) {
        case 'system':
          if (evt.subtype === 'init') {
            emit('init', {
              sessionId: evt.session_id,
              model: evt.model,
              cwd: evt.cwd,
            });
          }
          return;

        case 'assistant': {
          const content = evt.message?.content;
          if (!Array.isArray(content)) return;
          for (const c of content) {
            if (c?.type === 'thinking') {
              emit('thinking', { text: (c.thinking || c.text || '').slice(0, 4000) });
            } else if (c?.type === 'tool_use') {
              if (c.name && !toolsUsed.includes(c.name)) toolsUsed.push(c.name);
              emit('tool_use', { toolName: c.name, toolInput: c.input });
            } else if (c?.type === 'text') {
              // For this CLI version each assistant/text event carries a
              // complete chunk, not an incremental delta — but we emit it
              // as-is so the renderer can show progressive text for multi-
              // turn tool workflows.
              const text = c.text || '';
              finalText = text; // last assistant/text chunk wins; `result` will overwrite if present
              emit('text', { text });
            }
          }
          return;
        }

        case 'user': {
          // user-role events in the stream are tool_result acks emitted by
          // the CLI after a tool call. We surface a bare 'tool_result' so
          // renderers can clear/acknowledge the preceding "using X" status.
          emit('tool_result', { ok: true });
          return;
        }

        case 'result': {
          finalText = typeof evt.result === 'string' ? evt.result : finalText;
          finalCost = typeof evt.total_cost_usd === 'number' ? evt.total_cost_usd : finalCost;
          finalDurationMs = typeof evt.duration_ms === 'number' ? evt.duration_ms : finalDurationMs;
          if (evt.is_error) {
            hadError = (typeof evt.result === 'string' && evt.result) ||
                       evt.api_error_status || 'Claude returned an error';
            emit('error', { error: hadError });
          } else {
            emit('final', {
              text: finalText,
              cost: finalCost,
              durationMs: finalDurationMs,
              toolsUsed: toolsUsed.slice(),
              sessionId: discoveredSessionId,
            });
          }
          return;
        }

        case 'rate_limit_event':
          // Noisy; surface at debug only. Renderer doesn't need it.
          log.debug('stream-json: rate_limit_event', { info: evt.rate_limit_info });
          return;

        default:
          log.debug('stream-json: unhandled event', { type: evt.type, subtype: evt.subtype });
          return;
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn('Claude (streaming) timeout kill', { chatKey, sessionId: sessionId?.slice(0, 8), timeoutMs: timeout });
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
    }, timeout);

    const entry = {
      child,
      sessionId,
      startedAt: Date.now(),
      interrupt() {
        if (interrupted) return false;
        interrupted = true;
        log.info('Claude (streaming) interrupted by user', { chatKey, sessionId: sessionId?.slice(0, 8) });
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
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

      // Flush any final buffered line (no trailing newline)
      if (buffer.trim()) {
        try { handleEvent(JSON.parse(buffer)); }
        catch { /* ignore tail garbage */ }
      }

      let errMsg = hadError;
      if (!errMsg) {
        if (interrupted) errMsg = 'interrupted by user';
        else if (timedOut) errMsg = `timed out after ${Math.round(timeout / 1000)}s`;
        else if (code !== 0 && !finalText) errMsg = stderr.trim() || `Claude exited with code ${code}`;
      }

      resolve({
        result: finalText || null,
        sessionId: discoveredSessionId,
        cost: finalCost,
        error: errMsg || null,
        timedOut,
        interrupted,
        toolsUsed: toolsUsed.slice(),
      });
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
        toolsUsed: [],
      });
    });
  });
}

module.exports = { invokeClaude, streamClaude, interruptJob, getActiveJob };
