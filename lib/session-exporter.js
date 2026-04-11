// ============================================================================
// lib/session-exporter.js — Render a Claude Code session JSONL into clean
// Markdown for the /export command (v1.4.0+).
//
// Session JSONL format (inferred from ~/.claude/projects/*/*.jsonl):
//   Each line is one JSON entry with a `type` field and (usually) `timestamp`.
//   Types we care about:
//     - "user"       → user message with message.content (string or blocks)
//     - "assistant"  → Claude's reply with message.content (array of blocks)
//   Block types inside message.content:
//     - text         → regular prose
//     - thinking     → Claude's internal reasoning (we include this but tagged)
//     - tool_use     → Claude calling a tool (we render condensed)
//     - tool_result  → tool output (we render truncated)
//     - image        → attached image (we note its presence)
//     - document     → attached document (we note its presence)
//   Types we skip:
//     - queue-operation, attachment, system, and any unknown type
// ============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_TOOL_RESULT_LEN = 400; // truncate long tool outputs

/**
 * Find the JSONL file for a given session ID by scanning ~/.claude/projects/.
 * Returns the absolute path, or null if not found.
 */
function findSessionFile(sessionId) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  let buckets;
  try { buckets = fs.readdirSync(projectsDir); }
  catch { return null; }

  for (const bucket of buckets) {
    const bucketPath = path.join(projectsDir, bucket);
    let stat;
    try { stat = fs.statSync(bucketPath); }
    catch { continue; }
    if (!stat.isDirectory()) continue;

    const candidate = path.join(bucketPath, sessionId + '.jsonl');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Read and parse a session JSONL file. Skips blank lines and entries that
 * fail to parse. Returns an array of entry objects.
 */
function readSession(filePath) {
  const entries = [];
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); }
    catch { /* skip malformed line */ }
  }
  return entries;
}

/**
 * Format a single user message block as a Markdown snippet.
 */
function renderUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const out = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        out.push(block.text || '');
        break;
      case 'tool_result':
        out.push(renderToolResult(block));
        break;
      case 'image':
        out.push('_[image attached]_');
        break;
      case 'document':
        out.push('_[document attached]_');
        break;
    }
  }
  return out.join('\n\n');
}

/**
 * Format a tool_result block. Tool results can be very long — we truncate.
 */
function renderToolResult(block) {
  let text = '';
  const c = block.content;
  if (typeof c === 'string') {
    text = c;
  } else if (Array.isArray(c)) {
    const parts = [];
    for (const inner of c) {
      if (inner?.type === 'text') parts.push(inner.text || '');
    }
    text = parts.join('\n');
  }
  if (text.length > MAX_TOOL_RESULT_LEN) {
    text = text.slice(0, MAX_TOOL_RESULT_LEN) + '\n… [truncated]';
  }
  return '> **Tool result:**\n> ```\n> ' + text.replace(/\n/g, '\n> ') + '\n> ```';
}

/**
 * Format an assistant entry. Returns a Markdown string combining all the
 * text/thinking/tool_use blocks in order.
 */
function renderAssistantContent(content) {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }

  const out = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (block.text) out.push(block.text);
        break;
      case 'thinking':
        // Render thinking blocks as blockquoted italic so users can skim past
        if (block.thinking) {
          const thinkingText = String(block.thinking).trim();
          if (thinkingText) out.push('> _Thinking:_ ' + thinkingText.replace(/\n/g, '\n> '));
        }
        break;
      case 'tool_use':
        out.push(renderToolUse(block));
        break;
    }
  }
  return out.join('\n\n');
}

/**
 * Render a tool_use block concisely. We try to surface the most useful
 * input field per known tool (file_path for Read/Edit/Write, pattern for
 * Grep, command for Bash, etc). Unknown tools get a condensed input dump.
 */
function renderToolUse(block) {
  const name = block.name || 'tool';
  const input = block.input || {};

  const TOOL_PRIMARY_FIELD = {
    Read:         'file_path',
    Edit:         'file_path',
    Write:        'file_path',
    NotebookEdit: 'notebook_path',
    Bash:         'command',
    BashOutput:   'bash_id',
    Grep:         'pattern',
    Glob:         'pattern',
    WebFetch:     'url',
    WebSearch:    'query',
    Task:         'description',
  };

  const primary = TOOL_PRIMARY_FIELD[name];
  if (primary && input[primary] != null) {
    let value = String(input[primary]);
    if (value.length > 200) value = value.slice(0, 200) + '…';
    return `**${name}**: \`${value}\``;
  }

  // Unknown tool — dump a compact representation of the input
  const json = JSON.stringify(input);
  const compact = json.length > 200 ? json.slice(0, 200) + '…' : json;
  return `**${name}**: \`${compact}\``;
}

/**
 * Format a timestamp as a short human-readable ET-ish string. We don't
 * try to be fancy about timezones; timestamps are ISO-8601 in the JSONL.
 */
function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts;
  // YYYY-MM-DD HH:MM
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/**
 * Render an entire session as Markdown. Returns the string.
 *
 * @param {string} sessionId
 * @param {Array}  entries   Parsed JSONL entries
 */
function renderSessionMarkdown(sessionId, entries) {
  const conversational = entries.filter(e => e.type === 'user' || e.type === 'assistant');
  const firstTs = conversational[0]?.timestamp;
  const lastTs = conversational[conversational.length - 1]?.timestamp;

  let userTurns = 0;
  let assistantTurns = 0;
  for (const e of conversational) {
    if (e.type === 'user') userTurns++;
    else if (e.type === 'assistant') assistantTurns++;
  }

  const lines = [
    `# Claude Code Session`,
    '',
    `**Session ID:** \`${sessionId}\`  `,
    firstTs ? `**Started:** ${formatTimestamp(firstTs)}  ` : '',
    lastTs  ? `**Last activity:** ${formatTimestamp(lastTs)}  ` : '',
    `**User turns:** ${userTurns}  `,
    `**Assistant turns:** ${assistantTurns}  `,
    '',
    '---',
    '',
  ].filter(Boolean);

  for (const entry of conversational) {
    const ts = entry.timestamp ? formatTimestamp(entry.timestamp) : '';
    const content = entry.message?.content;

    if (entry.type === 'user') {
      const body = renderUserContent(content).trim();
      if (!body) continue;
      // Skip entries that are just tool_result echoes — they've already
      // been rendered by the assistant block that triggered the tool call.
      // But user text messages (prompts, replies) we keep.
      const isOnlyToolResult = Array.isArray(content)
        && content.every(b => b?.type === 'tool_result');
      if (isOnlyToolResult) continue;
      lines.push(`## 🧑 User${ts ? ` — ${ts}` : ''}`, '', body, '');
    } else {
      const body = renderAssistantContent(content).trim();
      if (!body) continue;
      lines.push(`## 🤖 Claude${ts ? ` — ${ts}` : ''}`, '', body, '');
    }
  }

  return lines.join('\n');
}

/**
 * Write a session's Markdown export to a temp file. Returns the absolute
 * path to the written file. Caller is responsible for cleanup.
 *
 * @param {string} sessionId
 * @returns {Promise<{ path: string, size: number }>}
 */
async function exportSession(sessionId) {
  const jsonlPath = findSessionFile(sessionId);
  if (!jsonlPath) {
    throw new Error(`Session file not found for ${sessionId}`);
  }

  const entries = readSession(jsonlPath);
  if (entries.length === 0) {
    throw new Error('Session file is empty or unreadable');
  }

  const md = renderSessionMarkdown(sessionId, entries);

  const outPath = path.join(os.tmpdir(), `session-${sessionId.slice(0, 8)}.md`);
  fs.writeFileSync(outPath, md, 'utf8');
  const size = Buffer.byteLength(md, 'utf8');

  return { path: outPath, size };
}

module.exports = {
  exportSession,
  // Exported for testing
  renderSessionMarkdown,
  renderAssistantContent,
  renderUserContent,
  renderToolUse,
  findSessionFile,
  readSession,
};
