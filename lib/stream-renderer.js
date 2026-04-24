// v1.7.0: live-status renderer for a single Claude streaming turn.
//
// Given the streamed events produced by lib/claude-cli.js:streamClaude, this
// module owns a single Telegram message's lifecycle:
//
//   1. send a seed placeholder on the FIRST meaningful event
//   2. editMessageText as status changes (thinking → using tool → typing...)
//   3. on final, replace the seed with the full response text
//
// We deliberately do NOT stream text tokens — the Claude CLI emits per-turn
// chunks, not deltas. What we have is progressive event-level information
// ("Claude is reading X", "Claude is running Y"), which is a better fit for a
// phone anyway. The user sees work happening instead of a 30s typing dot.
//
// Telegram rate limits: a bot can send ~30 msg/s overall and ~1 edit/s per
// chat before getting 429'd. We throttle every edit with a small min-interval
// and coalesce, so rapid-fire events collapse into a single redraw.

const log = require('./logger');
const { formatResponse } = require('./formatter');

const DEFAULT_MIN_EDIT_MS = 800;     // throttle between edits on the same message
const DEFAULT_MAX_STATUS_CHARS = 3500;

const TOOL_ICONS = {
  Read: '📖', Glob: '🔍', Grep: '🔎', Bash: '🖥', Edit: '✏', Write: '📝',
  NotebookEdit: '📓', WebFetch: '🌐', WebSearch: '🌐', Task: '🤖',
  TodoWrite: '✅', Skill: '🧩', ToolSearch: '🔧',
};

function toolIcon(name) {
  if (!name) return '🔧';
  return TOOL_ICONS[name] || '🔧';
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Returns a short, human-readable summary of a tool_use input — e.g. for
 * Read it shows the file path; for Bash the first line of the command. Keeps
 * the status line scannable on a narrow phone screen.
 */
function summarizeTool(name, input) {
  if (!input || typeof input !== 'object') return name || 'tool';
  const s = (v) => (typeof v === 'string' ? v : JSON.stringify(v || ''));
  switch (name) {
    case 'Read':         return `Read ${escHtml(s(input.file_path)).slice(0, 100)}`;
    case 'Write':        return `Write ${escHtml(s(input.file_path)).slice(0, 100)}`;
    case 'Edit':         return `Edit ${escHtml(s(input.file_path)).slice(0, 100)}`;
    case 'NotebookEdit': return `Edit notebook ${escHtml(s(input.notebook_path)).slice(0, 100)}`;
    case 'Glob':         return `Glob <code>${escHtml(s(input.pattern)).slice(0, 80)}</code>`;
    case 'Grep':         return `Grep <code>${escHtml(s(input.pattern)).slice(0, 80)}</code>`;
    case 'Bash': {
      const first = s(input.command).split('\n')[0].slice(0, 120);
      return `Bash <code>${escHtml(first)}</code>`;
    }
    case 'WebFetch':     return `WebFetch ${escHtml(s(input.url)).slice(0, 100)}`;
    case 'WebSearch':    return `WebSearch <i>${escHtml(s(input.query)).slice(0, 80)}</i>`;
    case 'Task':         return `Delegating: <i>${escHtml(s(input.description)).slice(0, 80)}</i>`;
    case 'Skill':        return `Skill <b>${escHtml(s(input.skill))}</b>`;
    default:             return escHtml(name || 'tool');
  }
}

/**
 * Build a status message body (HTML) from the current renderer state.
 * Compact so the live-edit payload stays well under Telegram's 4096 cap.
 */
function renderStatus(state) {
  const lines = [];
  const header = state.sessionShort
    ? `<i>Claude (<code>${state.sessionShort}</code>)</i>`
    : '<i>Claude</i>';
  lines.push(header);
  lines.push('');

  if (state.phase === 'starting') {
    lines.push('🤔 <i>Starting…</i>');
  } else if (state.phase === 'thinking') {
    lines.push('🤔 <i>Thinking…</i>');
  } else if (state.phase === 'tool' && state.currentTool) {
    lines.push(`${toolIcon(state.currentTool.name)} <i>Using</i> <b>${escHtml(state.currentTool.name)}</b>`);
    if (state.currentTool.summary) {
      lines.push(`<i>${state.currentTool.summary}</i>`);
    }
  } else if (state.phase === 'replying') {
    lines.push('📝 <i>Replying…</i>');
  } else if (state.phase === 'done') {
    lines.push('✅ <i>Done.</i>');
  } else if (state.phase === 'error') {
    lines.push(`⚠ <i>${escHtml(state.errorText || 'Error')}</i>`);
  }

  if (state.toolsUsed.length > 0 && state.phase !== 'done') {
    const tools = state.toolsUsed.slice(-6).join(', ');
    lines.push('');
    lines.push(`<i>Tools so far: ${escHtml(tools)}${state.toolsUsed.length > 6 ? '…' : ''}</i>`);
  }

  const out = lines.join('\n');
  return out.length > DEFAULT_MAX_STATUS_CHARS
    ? out.slice(0, DEFAULT_MAX_STATUS_CHARS) + '…'
    : out;
}

/**
 * Factory. Returns a renderer bound to one chat + one seed Telegram message.
 * Call renderer.onEvent(evt) for every event from streamClaude and renderer
 * will manage the message. When the stream finishes, call renderer.finalize()
 * to replace the seed with the final response and return any overflow chunks
 * that need to be sent as fresh messages.
 *
 * @param {object} bot — node-telegram-bot-api instance
 * @param {number|string} chatId — target chat id
 * @param {object} [opts]
 * @param {number} [opts.replyTo] — reply_to_message_id for the seed
 * @param {number} [opts.minEditMs=800] — throttle edits to at most one per N ms
 * @param {function} [opts.keyboardBuilder] — returns inline_keyboard for the final message
 */
function createRenderer(bot, chatId, opts = {}) {
  // Nullish coalescing (not `||`) so tests can pass minEditMs: 0 to disable
  // throttling and the default still applies for undefined.
  const minEditMs = opts.minEditMs ?? DEFAULT_MIN_EDIT_MS;
  const replyTo = opts.replyTo;
  const keyboardBuilder = opts.keyboardBuilder || (() => null);

  const state = {
    phase: 'starting',       // starting|thinking|tool|replying|done|error
    sessionShort: null,
    currentTool: null,       // { name, summary }
    toolsUsed: [],           // names only, for the running footer
    errorText: null,
  };

  let seedMsgId = null;
  let seedPromise = null;     // in-flight seed send; callers await the same promise
  let sending = false;        // true while an API call is in flight
  let pendingEdit = false;    // a render requested during an in-flight edit
  let lastEditAt = 0;
  let lastRenderedBody = null;
  let throttleTimer = null;

  function ensureSeed() {
    if (seedMsgId !== null) return Promise.resolve(seedMsgId);
    if (seedPromise) return seedPromise;
    const body = renderStatus(state);
    const opts2 = { parse_mode: 'HTML', disable_web_page_preview: true };
    if (replyTo) opts2.reply_to_message_id = replyTo;
    seedPromise = (async () => {
      try {
        const sent = await bot.sendMessage(chatId, body, opts2);
        seedMsgId = sent.message_id;
        lastRenderedBody = body;
        lastEditAt = Date.now();
        return seedMsgId;
      } catch (e) {
        log.warn('stream-renderer: seed send failed', { error: e.message });
        return null;
      } finally {
        // Keep seedPromise resolved so later callers see the cached result;
        // only null it if we want to retry on next call.
      }
    })();
    return seedPromise;
  }

  async function editNow() {
    if (seedMsgId === null) return;
    const body = renderStatus(state);
    if (body === lastRenderedBody) return;
    sending = true;
    try {
      await bot.editMessageText(body, {
        chat_id: chatId,
        message_id: seedMsgId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      lastRenderedBody = body;
      lastEditAt = Date.now();
    } catch (e) {
      // "message is not modified" is noise; everything else at debug
      if (!/not modified/i.test(e.message || '')) {
        log.debug('stream-renderer: edit failed', { error: e.message });
      }
    } finally {
      sending = false;
      if (pendingEdit) {
        pendingEdit = false;
        scheduleEdit();
      }
    }
  }

  function scheduleEdit() {
    if (seedMsgId === null) {
      // ensureSeed() memoizes the in-flight send, so multiple callers just
      // await the same promise — no duplicate seed messages.
      ensureSeed().then(() => scheduleEdit());
      return;
    }
    if (sending) { pendingEdit = true; return; }
    const now = Date.now();
    const waited = now - lastEditAt;
    if (waited >= minEditMs) {
      editNow();
    } else if (!throttleTimer) {
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        editNow();
      }, minEditMs - waited);
    }
  }

  function onEvent(evt) {
    switch (evt.kind) {
      case 'init':
        if (evt.sessionId) state.sessionShort = String(evt.sessionId).slice(0, 8);
        state.phase = 'thinking';
        ensureSeed();
        scheduleEdit();
        return;
      case 'thinking':
        state.phase = 'thinking';
        scheduleEdit();
        return;
      case 'tool_use':
        state.phase = 'tool';
        state.currentTool = {
          name: evt.toolName || 'tool',
          summary: summarizeTool(evt.toolName, evt.toolInput),
        };
        if (evt.toolName && !state.toolsUsed.includes(evt.toolName)) {
          state.toolsUsed.push(evt.toolName);
        }
        scheduleEdit();
        return;
      case 'tool_result':
        // Finished the current tool call; show "replying" as a gentle hint
        // that Claude is back to text generation.
        state.currentTool = null;
        state.phase = 'replying';
        scheduleEdit();
        return;
      case 'text':
        state.phase = 'replying';
        scheduleEdit();
        return;
      case 'error':
        state.phase = 'error';
        state.errorText = evt.error;
        scheduleEdit();
        return;
      case 'final':
        // final is handled by finalize() below — the caller swaps in the
        // real response text with formatting, chunking, and a keyboard.
        return;
    }
  }

  /**
   * Replace the seed placeholder with the final response text. Applies the
   * same HTML formatting + chunking as the synchronous path used before v1.7,
   * so long responses still split at paragraph boundaries.
   *
   * Returns { firstMessageId, extraChunksSent } so the caller can log it.
   */
  async function finalize({ text, keyboardForLastChunk = true }) {
    // Cancel any pending throttled edit so it can't race with our final write
    if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
    pendingEdit = false;
    // Wait for any in-flight edit to settle
    while (sending) await new Promise(r => setTimeout(r, 50));

    const chunks = text ? formatResponse(text) : ['<i>(empty response)</i>'];
    const keyboard = keyboardForLastChunk ? keyboardBuilder() : null;

    // First chunk overwrites the seed; remaining chunks are sent as new msgs
    await ensureSeed();
    if (seedMsgId === null) {
      // Seed never went through — just send chunks fresh
      let firstId = null;
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const opts2 = { parse_mode: 'HTML', disable_web_page_preview: true };
        if (i === 0 && replyTo) opts2.reply_to_message_id = replyTo;
        if (isLast && keyboard)  opts2.reply_markup = keyboard;
        try {
          const sent = await bot.sendMessage(chatId, chunks[i], opts2);
          if (firstId === null) firstId = sent.message_id;
        } catch (e) {
          if (/parse/i.test(e.message)) {
            const plainOpts = {};
            if (i === 0 && replyTo) plainOpts.reply_to_message_id = replyTo;
            if (isLast && keyboard)  plainOpts.reply_markup = keyboard;
            const sent = await bot.sendMessage(chatId, chunks[i].replace(/<[^>]+>/g, ''), plainOpts);
            if (firstId === null) firstId = sent.message_id;
          } else { throw e; }
        }
      }
      return { firstMessageId: firstId, extraChunksSent: Math.max(0, chunks.length - 1) };
    }

    // Normal path: edit seed with first chunk
    const firstIsOnly = chunks.length === 1;
    const editOpts = {
      chat_id: chatId,
      message_id: seedMsgId,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (firstIsOnly && keyboard) editOpts.reply_markup = keyboard;

    try {
      await bot.editMessageText(chunks[0], editOpts);
    } catch (e) {
      if (/parse/i.test(e.message)) {
        const plainOpts = { chat_id: chatId, message_id: seedMsgId };
        if (firstIsOnly && keyboard) plainOpts.reply_markup = keyboard;
        await bot.editMessageText(chunks[0].replace(/<[^>]+>/g, ''), plainOpts);
      } else {
        log.warn('stream-renderer: final edit failed', { error: e.message });
      }
    }

    // Remaining chunks as new messages
    for (let i = 1; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const opts2 = { parse_mode: 'HTML', disable_web_page_preview: true };
      if (isLast && keyboard) opts2.reply_markup = keyboard;
      try {
        await bot.sendMessage(chatId, chunks[i], opts2);
      } catch (e) {
        if (/parse/i.test(e.message)) {
          const plainOpts = {};
          if (isLast && keyboard) plainOpts.reply_markup = keyboard;
          await bot.sendMessage(chatId, chunks[i].replace(/<[^>]+>/g, ''), plainOpts);
        } else { throw e; }
      }
    }

    return { firstMessageId: seedMsgId, extraChunksSent: Math.max(0, chunks.length - 1) };
  }

  /**
   * Replace the seed with an error message instead of a response. Used when
   * the stream finished but produced no text (timeout, interrupt, resume
   * failure surfaced by the result event).
   */
  async function finalizeError(htmlText) {
    if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
    pendingEdit = false;
    while (sending) await new Promise(r => setTimeout(r, 50));
    await ensureSeed();
    if (seedMsgId === null) {
      const opts2 = { parse_mode: 'HTML', disable_web_page_preview: true };
      if (replyTo) opts2.reply_to_message_id = replyTo;
      await bot.sendMessage(chatId, htmlText, opts2);
      return;
    }
    try {
      await bot.editMessageText(htmlText, {
        chat_id: chatId,
        message_id: seedMsgId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (e) {
      log.warn('stream-renderer: error finalize failed', { error: e.message });
    }
  }

  return { onEvent, finalize, finalizeError, _getSeedId: () => seedMsgId, _getState: () => state };
}

module.exports = {
  createRenderer,
  // exported for tests
  renderStatus,
  summarizeTool,
  toolIcon,
};
