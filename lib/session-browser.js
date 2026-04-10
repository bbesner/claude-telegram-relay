const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('./logger');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_SESSIONS = 20; // Maximum sessions to return in a listing

/**
 * Maps a project bucket directory name back to a human-readable path.
 * e.g. "-home-ubuntu-ari" → "/home/ubuntu/ari"
 */
function bucketToPath(bucket) {
  // Leading "-" represents the root slash, subsequent "-" are path separators.
  // We need to be careful: directory names like "my-project" use "-" too.
  // Claude Code replaces "/" with "-" in the path, so we reverse that.
  // The bucket always starts with "-" for the leading "/".
  return bucket.replace(/^-/, '/').replace(/-/g, '/');
}

/**
 * Returns a short display label for a project bucket.
 * e.g. "-home-ubuntu" → "~", "-home-ubuntu-ari" → "~/ari"
 */
function bucketLabel(bucket) {
  const p = bucketToPath(bucket);
  const home = os.homedir();
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~/' + p.slice(home.length + 1);
  return p;
}

/**
 * Extract the first meaningful user text from a session JSONL file.
 * Skips tool results, local-command caveats, and empty messages.
 */
function extractFirstUserMessage(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(32 * 1024); // Read first 32KB
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);

    const chunk = buf.slice(0, bytesRead).toString('utf8');
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry.type !== 'user') continue;

      const content = entry.message?.content;
      let text = '';

      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'text') { text = c.text; break; }
        }
      } else if (typeof content === 'string') {
        text = content;
      }

      text = text.trim();

      // Skip non-useful entries
      if (!text) continue;
      if (text.startsWith('<local-command-caveat>')) continue;
      if (text.startsWith('claude --resume')) continue;
      if (text.length < 5) continue;

      return text;
    }
  } catch (err) {
    log.debug('session-browser: failed to read session', { filePath, error: err.message });
  }
  return null;
}

/**
 * Returns all Claude Code sessions across all project buckets, sorted newest first.
 * Each entry: { sessionId, bucket, bucketLabel, mtime, sizeKb, snippet, isFromRelay }
 *
 * @param {Set<string>} relaySessionIds - Set of session IDs known to the relay
 */
function listAllSessions(relaySessionIds = new Set()) {
  if (!fs.existsSync(PROJECTS_DIR)) {
    log.warn('session-browser: projects directory not found', { dir: PROJECTS_DIR });
    return [];
  }

  const results = [];

  let buckets;
  try {
    buckets = fs.readdirSync(PROJECTS_DIR);
  } catch (err) {
    log.error('session-browser: cannot read projects dir', { error: err.message });
    return [];
  }

  for (const bucket of buckets) {
    const bucketPath = path.join(PROJECTS_DIR, bucket);
    let files;
    try {
      const stat = fs.statSync(bucketPath);
      if (!stat.isDirectory()) continue;
      files = fs.readdirSync(bucketPath).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace('.jsonl', '');
      // Skip companion files (non-UUID filenames)
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) {
        continue;
      }

      const filePath = path.join(bucketPath, file);
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }

      results.push({
        sessionId,
        bucket,
        bucketLabel: bucketLabel(bucket),
        mtime: stat.mtimeMs,
        sizeKb: Math.round(stat.size / 1024),
        snippet: null, // Lazy-loaded below for top N only
        isFromRelay: relaySessionIds.has(sessionId),
      });
    }
  }

  // Sort newest first
  results.sort((a, b) => b.mtime - a.mtime);

  // Load snippets only for the sessions we'll actually show
  const top = results.slice(0, MAX_SESSIONS);
  for (const s of top) {
    const filePath = path.join(PROJECTS_DIR, s.bucket, s.sessionId + '.jsonl');
    s.snippet = extractFirstUserMessage(filePath);
  }

  return top;
}

/**
 * Format a session list for Telegram display.
 * Returns an HTML string.
 */
function formatSessionList(sessions) {
  if (sessions.length === 0) {
    return 'No Claude Code sessions found.';
  }

  const lines = ['<b>Recent Claude Code Sessions</b>', ''];

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const n = i + 1;
    const date = new Date(s.mtime);
    const now = new Date();
    const diffMs = now - date;
    const diffH = Math.floor(diffMs / 3600000);
    const diffD = Math.floor(diffMs / 86400000);

    let age;
    if (diffH < 1) age = 'just now';
    else if (diffH < 24) age = `${diffH}h ago`;
    else if (diffD === 1) age = 'yesterday';
    else age = `${diffD}d ago`;

    const label = s.bucketLabel !== '~' ? ` <i>${s.bucketLabel}</i>` : '';
    const relayMark = s.isFromRelay ? ' 📱' : '';
    const snippet = s.snippet
      ? s.snippet.slice(0, 80) + (s.snippet.length > 80 ? '…' : '')
      : '(no preview)';

    lines.push(`<b>${n}.</b> ${age}${label}${relayMark}`);
    lines.push(`   <code>${s.sessionId.slice(0, 8)}</code>  ${s.sizeKb}KB`);
    lines.push(`   ${escapeHtml(snippet)}`);
    lines.push('');
  }

  lines.push('<i>📱 = started via Telegram</i>');
  lines.push('');
  lines.push('Resume: <code>/resume 3</code>  or  <code>/resume &lt;full-id&gt;</code>');

  return lines.join('\n');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { listAllSessions, formatSessionList };
