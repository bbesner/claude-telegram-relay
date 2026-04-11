// ============================================================================
// lib/openclaw-memory.js — Optional OpenClaw memory search passthrough.
//
// Auto-detects an OpenClaw installation and, if found, exposes a
// token-free /memory search command to the bot. This is the v1.4.0
// "FlipClaw users get direct memory access" feature.
//
// Detection chain (first match wins):
//   1. process.env.OPENCLAW_CONFIG_PATH (explicit override from .env)
//   2. ~/.openclaw/openclaw.json (default OpenClaw install location)
// Binary:
//   - process.env.OPENCLAW_BIN if set, else "openclaw" from PATH
// Working dir:
//   - process.env.OPENCLAW_CWD if set, else the directory containing
//     the detected config file (so relative paths inside the config
//     resolve correctly)
//
// Standalone relay users (no OpenClaw) never see the /memory command —
// detectOpenclaw() returns null and commands.js skips registration.
// ============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const log = require('./logger');

/**
 * Detect an OpenClaw installation suitable for running `openclaw memory search`.
 * Returns { configPath, cwd, binary } on success, or null if OpenClaw isn't
 * available. This is called once at startup by commands.js; runtime toggling
 * isn't supported.
 */
function detectOpenclaw() {
  // 1. Config path — explicit env var first, then default install location
  const candidates = [];
  if (process.env.OPENCLAW_CONFIG_PATH) {
    candidates.push(process.env.OPENCLAW_CONFIG_PATH);
  }
  candidates.push(path.join(os.homedir(), '.openclaw', 'openclaw.json'));

  let configPath = null;
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        configPath = c;
        break;
      }
    } catch { /* ignore and try next */ }
  }
  if (!configPath) {
    log.debug('openclaw-memory: no config found, /memory will be disabled');
    return null;
  }

  // 2. Binary — default to "openclaw" from PATH, spawn will fail at call time
  //    if it isn't actually there, but that's better than blocking startup
  //    with a synchronous PATH probe.
  const binary = process.env.OPENCLAW_BIN || 'openclaw';

  // 3. Working dir — prefer explicit override, else the config's directory
  const cwd = process.env.OPENCLAW_CWD || path.dirname(configPath);

  log.info('openclaw-memory: detected', { configPath, cwd, binary });
  return { configPath, cwd, binary };
}

/**
 * Run `openclaw memory search <query> --max-results N --json` and return the
 * parsed results. Never shell-interpolates the query — it goes through argv.
 *
 * The default timeout is intentionally generous (90s). A cold-cache query
 * against a large semantic-hybrid memory index (like Ari's Gemini+LanceDB
 * setup) legitimately takes ~60s the first time as the embedding provider
 * warms up and indexes load. Override via OPENCLAW_SEARCH_TIMEOUT_MS in .env
 * or the timeoutMs option.
 *
 * @param {string} query         Search query (user input, treated as opaque)
 * @param {object} detected      Return value from detectOpenclaw()
 * @param {object} [options]
 * @param {number} [options.maxResults=5]
 * @param {number} [options.timeoutMs]  Defaults to OPENCLAW_SEARCH_TIMEOUT_MS env or 90000
 * @returns {Promise<{ results: Array<{path,startLine,endLine,score,snippet,source}> }>}
 */
function searchMemory(query, detected, options = {}) {
  const maxResults = options.maxResults || 5;
  const envTimeout = parseInt(process.env.OPENCLAW_SEARCH_TIMEOUT_MS || '', 10);
  const timeoutMs = options.timeoutMs
    || (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 90000);

  return new Promise((resolve, reject) => {
    const args = [
      'memory', 'search', query,
      '--max-results', String(maxResults),
      '--json',
    ];

    const child = spawn(detected.binary, args, {
      cwd: detected.cwd,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: detected.configPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
      reject(new Error(`openclaw memory search timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn openclaw: ${e.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `openclaw exited with code ${code}`));
        return;
      }

      // openclaw can produce "No matches." as plain text when --json has
      // zero hits in some versions — handle both.
      const trimmed = stdout.trim();
      if (!trimmed || trimmed === 'No matches.') {
        resolve({ results: [] });
        return;
      }

      try {
        const parsed = JSON.parse(trimmed);
        // Accept either { results: [...] } or a bare array (future-proofing
        // against minor openclaw CLI shape changes).
        const results = Array.isArray(parsed) ? parsed : (parsed.results || []);
        resolve({ results });
      } catch (e) {
        reject(new Error(`failed to parse openclaw JSON: ${e.message}`));
      }
    });
  });
}

/**
 * Render a search result set as a Telegram-safe HTML message.
 * Escapes HTML in snippets and paths. Keeps each result concise.
 */
function formatMemoryResults(query, results) {
  const escape = (s) => String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  if (!results || results.length === 0) {
    return `No memory matches for <code>${escape(query)}</code>.`;
  }

  const lines = [`<b>Memory search:</b> <code>${escape(query)}</code>`, ''];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const n = i + 1;
    const score = typeof r.score === 'number' ? r.score.toFixed(2) : '?';
    const loc = r.startLine != null
      ? `${r.path}:${r.startLine}-${r.endLine}`
      : r.path || '(unknown)';
    let snippet = (r.snippet || '').trim();
    // Truncate long snippets; keep it phone-readable.
    if (snippet.length > 300) snippet = snippet.slice(0, 300) + '…';

    lines.push(`<b>${n}.</b> <code>${escape(loc)}</code> (${score})`);
    lines.push(escape(snippet));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

module.exports = { detectOpenclaw, searchMemory, formatMemoryResults };
