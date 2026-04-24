const {
  clearSession,
  getSession,
  setSessionById,
  getUserModel,
  setUserModel,
  saveSessionLabel,
  getSessionByLabel,
  getAllRelaySessionIds,
  setSessionListing,
  getSessionFromListing,
  sessionKey,
} = require('./session-manager');
const { listAllSessions, formatSessionList, sessionFileExists } = require('./session-browser');
// Lazy-load claude-cli — it performs a binary lookup at module load and
// process.exits if `claude` isn't on PATH. Keeping it lazy means tests and
// environments without the CLI can still require commands.js.
function _claudeCli() { return require('./claude-cli'); }
const { detectOpenclaw, searchMemory, formatMemoryResults } = require('./openclaw-memory');
const { exportSession } = require('./session-exporter');
const log = require('./logger');

const startTime = Date.now();

// Detect OpenClaw once at module load. Null if not installed — /memory
// is simply never registered, standalone users see no trace of it.
const OPENCLAW = detectOpenclaw();

// UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Pass-through commands — these get forwarded to Claude Code as prompts.
 * The key is the command name, the value is a function that builds the prompt.
 */
const PASSTHROUGH_COMMANDS = {
  status: () => 'Show full server status: PM2 services, disk usage, memory usage, and gateway health.',
  logs: (args) => {
    if (!args) return 'Show recent PM2 logs. Ask which service I want to see logs for.';
    return `Show recent logs for the "${args}" PM2 service. Use: pm2 logs ${args} --lines 50 --nostream`;
  },
  restart: (args) => {
    if (!args) return 'Ask which PM2 service I want to restart, and list the available services.';
    return `Restart the "${args}" PM2 service using pm2 restart. Confirm the result.`;
  },
  deploy: (args) => {
    if (!args) return 'Ask which site I want to deploy, and list the available sites.';
    return `Deploy the "${args}" site. Follow the deploy skill if one exists.`;
  },
};

/**
 * Check if a message is a pass-through command.
 * Returns { prompt } if it is, null if not.
 */
function getPassthroughPrompt(text) {
  if (!text || !text.startsWith('/')) return null;

  const parts = text.split(/\s+/);
  const cmd = parts[0].replace('/', '').replace(/@\w+$/, '').toLowerCase();
  const args = parts.slice(1).join(' ').trim() || null;

  if (PASSTHROUGH_COMMANDS[cmd]) {
    return { prompt: PASSTHROUGH_COMMANDS[cmd](args) };
  }
  return null;
}

function registerCommands(bot) {
  bot.onText(/\/start/, (msg) => {
    const lines = [
      '<b>Claude Code Relay</b>',
      '',
      'Send me a message and I\'ll relay it to Claude Code CLI.',
      '',
      '<b>Session Commands:</b>',
      '/sessions — Browse all recent Claude Code sessions',
      '/resume &lt;n&gt; — Resume session by number from /sessions list',
      '/save &lt;name&gt; — Label the current session for easy recall',
      '/new — Start a fresh conversation',
      '/info — Show current session info (status, errors, cost)',
      '/cost — Show session cost totals',
      '/interrupt — Cancel the in-flight Claude request',
      '/export — Export the current session as a Markdown file',
      '/model — Show or set model (e.g. /model sonnet)',
      '/help — Show this message',
    ];
    if (OPENCLAW) {
      lines.push('');
      lines.push('<b>OpenClaw Memory:</b>');
      lines.push('/memory &lt;query&gt; — Search your OpenClaw memory directly');
    }
    lines.push('');
    lines.push('<b>Server Commands</b> (run via Claude Code):');
    lines.push('/status — Full server status (PM2, disk, memory, gateways)');
    lines.push('/logs [service] — Show recent logs for a service');
    lines.push('/restart [service] — Restart a PM2 service');
    lines.push('/deploy [site] — Deploy a site via SSH');
    lines.push('');
    lines.push('You can also send photos, PDFs, and files — Claude will analyze them.');
    lines.push('');
    lines.push('<i>claude-telegram-relay by <a href="https://github.com/bbesner">Brad Besner</a> · <a href="https://github.com/bbesner/claude-telegram-relay">⭐ Star on GitHub</a></i>');
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.onText(/\/help/, (msg) => {
    const lines = [
      '<b>Available Commands</b>',
      '',
      '<b>Session Commands</b> (instant, no AI):',
      '/sessions — List all recent Claude Code sessions across all interfaces',
      '/resume &lt;n&gt; — Resume session #n from the last /sessions list',
      '/resume &lt;session-id&gt; — Resume a specific session by full or partial ID',
      '/resume &lt;label&gt; — Resume a session by saved label',
      '/save &lt;name&gt; — Label the current session (e.g. /save sck-migration)',
      '/new — Clear session, start fresh conversation',
      '/info — Current session ID, status, cost, uptime',
      '/cost — Last-turn and cumulative session cost',
      '/interrupt — Cancel the in-flight Claude request (aliases: /stop, /cancel)',
      '/export — Export the current session as a Markdown file',
      '/model — Show current model',
      '/model &lt;name&gt; — Set model (e.g. sonnet, opus, haiku)',
      '/model default — Reset to default model',
      '/help — This message',
    ];
    if (OPENCLAW) {
      lines.push('');
      lines.push('<b>OpenClaw Memory</b> (auto-detected):');
      lines.push('/memory &lt;query&gt; — Search your OpenClaw memory (no AI tokens)');
    }
    lines.push('');
    lines.push('<b>Server Commands</b> (passed to Claude Code):');
    lines.push('/status — Full server status (PM2, disk, memory, gateways)');
    lines.push('/logs &lt;service&gt; — Recent logs for a PM2 service');
    lines.push('/restart &lt;service&gt; — Restart a PM2 service');
    lines.push('/deploy &lt;site&gt; — Deploy a site via SSH');
    lines.push('');
    lines.push('<b>Media Support</b>');
    lines.push('Send photos, screenshots, PDFs, or files and Claude will read/analyze them.');
    lines.push('When Claude creates files, they\'re automatically sent back to you.');
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  // /sessions — list all recent sessions across all project buckets
  bot.onText(/\/sessions/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      const relayIds = getAllRelaySessionIds();
      const sessions = listAllSessions(relayIds);

      // Store the listing so /resume <n> works
      setSessionListing(msg, sessions);

      const text = formatSessionList(sessions);
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
      log.error('/sessions error', { error: err.message });
      await bot.sendMessage(chatId, `Error listing sessions: ${err.message}`);
    }

    log.info('/sessions command', { chatId, userId: msg.from.id });
  });

  // /resume <n|id|label> — switch active session
  bot.onText(/\/resume(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const arg = match[1]?.trim();

    if (!arg) {
      await bot.sendMessage(chatId,
        'Usage:\n' +
        '<code>/resume 3</code> — resume by number from /sessions list\n' +
        '<code>/resume &lt;session-id&gt;</code> — resume by ID\n' +
        '<code>/resume &lt;label&gt;</code> — resume by saved label\n\n' +
        'Run /sessions first to see available sessions.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    let targetId = null;
    let resolvedBy = '';

    // Try by number (1-based index from last /sessions listing)
    const n = parseInt(arg, 10);
    if (!isNaN(n) && String(n) === arg) {
      targetId = getSessionFromListing(msg, n);
      resolvedBy = `#${n} from last /sessions list`;
    }

    // Try full UUID
    if (!targetId && UUID_RE.test(arg)) {
      targetId = arg.toLowerCase();
      resolvedBy = 'full session ID';
    }

    // Try partial UUID prefix (at least 8 chars)
    if (!targetId && /^[0-9a-f]{8,}/i.test(arg)) {
      const relayIds = getAllRelaySessionIds();
      const all = listAllSessions(relayIds);
      const match2 = all.find(s => s.sessionId.startsWith(arg.toLowerCase()));
      if (match2) {
        targetId = match2.sessionId;
        resolvedBy = `partial ID prefix "${arg}"`;
      }
    }

    // Try by saved label
    if (!targetId) {
      targetId = getSessionByLabel(arg);
      if (targetId) resolvedBy = `label "${arg}"`;
    }

    if (!targetId) {
      await bot.sendMessage(chatId,
        `Could not find a session matching <code>${arg}</code>.\n\n` +
        'Run /sessions to see the numbered list, then use /resume &lt;n&gt;.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    setSessionById(msg, targetId);

    await bot.sendMessage(chatId,
      `Resumed session (${resolvedBy}):\n<code>${targetId}</code>\n\nNext message continues that conversation.`,
      { parse_mode: 'HTML' }
    );

    log.info('/resume command', { chatId, userId: msg.from.id, sessionId: targetId.slice(0, 8), resolvedBy });
  });

  // /memory <query> — search OpenClaw memory (only registered if OpenClaw is detected)
  if (OPENCLAW) {
    bot.onText(/\/memory(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const query = match[1]?.trim();

      if (!query) {
        await bot.sendMessage(chatId,
          'Usage: <code>/memory &lt;query&gt;</code>\n' +
          'Example: <code>/memory sck migration status</code>\n\n' +
          'Searches your OpenClaw memory directly — no AI tokens used.',
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Keep the typing indicator alive for the duration of the search —
      // cold queries against a semantic memory index can legitimately take
      // 30-90s the first time, and Telegram's typing action only lasts ~5s
      // per call. Refresh every 4s until the search settles.
      bot.sendChatAction(chatId, 'typing').catch(() => {});
      const typingInterval = setInterval(() => {
        bot.sendChatAction(chatId, 'typing').catch(() => {});
      }, 4000);

      try {
        const { results } = await searchMemory(query, OPENCLAW, { maxResults: 5 });
        clearInterval(typingInterval);
        const text = formatMemoryResults(query, results);
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        log.info('/memory command', {
          chatId,
          userId: msg.from.id,
          query: query.slice(0, 80),
          resultCount: results.length,
        });
      } catch (err) {
        clearInterval(typingInterval);
        log.error('/memory error', { error: err.message });
        await bot.sendMessage(chatId, `Memory search failed: ${err.message}`);
      }
    });
  }

  // /save <name> — label the current session
  bot.onText(/\/save(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const label = match[1]?.trim();

    if (!label) {
      bot.sendMessage(chatId, 'Usage: <code>/save &lt;name&gt;</code>\nExample: <code>/save sck-migration</code>', { parse_mode: 'HTML' });
      return;
    }

    const session = getSession(msg);
    if (!session?.sessionId) {
      bot.sendMessage(chatId, 'No active session to label. Start a conversation first.');
      return;
    }

    const saved = saveSessionLabel(msg, label);
    if (saved) {
      bot.sendMessage(chatId,
        `Session labeled as <b>${label}</b>.\nResume later with: <code>/resume ${label}</code>`,
        { parse_mode: 'HTML' }
      );
      log.info('/save command', { chatId, userId: msg.from.id, label, sessionId: session.sessionId.slice(0, 8) });
    } else {
      bot.sendMessage(chatId, 'Failed to save label.');
    }
  });

  bot.onText(/\/new/, (msg) => {
    clearSession(msg);
    bot.sendMessage(msg.chat.id, 'Session cleared. Next message starts a fresh conversation.');
    log.info('/new command', { chatId: msg.chat.id, userId: msg.from.id });
  });

  bot.onText(/\/info/, (msg) => {
    const session = getSession(msg);
    const uptimeMs = Date.now() - startTime;
    const uptimeMin = Math.floor(uptimeMs / 60000);
    const uptimeHr = Math.floor(uptimeMin / 60);

    const lines = ['<b>Session Info</b>', ''];
    if (session?.sessionId) {
      // v1.6.0: surface continuity state so the user can tell whether this
      // thread is healthy, degraded, or silently replaced at some point.
      const status = session.status || 'active';
      const statusIcon = status === 'active' ? '🟢' : status === 'degraded' ? '🟡' : '🔴';
      const onDisk = sessionFileExists(session.sessionId);
      lines.push(`Session: <code>${session.sessionId}</code>`);
      lines.push(`Status: ${statusIcon} ${status}${onDisk ? '' : ' <i>(transcript missing on disk)</i>'}`);
      lines.push(`Messages: ${session.messageCount || 0}`);
      lines.push(`Started: ${session.startedAt || 'unknown'}`);
      if (session.lastSuccessAt) lines.push(`Last success: ${session.lastSuccessAt}`);
      if (session.resumedAt) lines.push(`Resumed: ${session.resumedAt}`);
      if (session.replacedPreviousSessionId) {
        lines.push(`Replaced: <code>${session.replacedPreviousSessionId.slice(0, 8)}</code>` +
                   (session.replacedReason ? ` (${session.replacedReason})` : ''));
      }
      if (session.lastResumeFailedAt) lines.push(`Last resume failure: ${session.lastResumeFailedAt}`);
      if (session.lastError) lines.push(`Last error: <code>${escapeHtml(String(session.lastError).slice(0, 160))}</code>`);
      if (typeof session.lastCostUsd === 'number')  lines.push(`Last turn cost: $${session.lastCostUsd.toFixed(4)}`);
      if (typeof session.totalCostUsd === 'number') lines.push(`Session total: $${session.totalCostUsd.toFixed(4)}`);

      const active = _claudeCli().getActiveJob(sessionKey(msg));
      if (active) {
        lines.push(`Active job: running for ${Math.round(active.elapsedMs / 1000)}s — <code>/interrupt</code> to cancel`);
      }
    } else {
      lines.push('No active session');
    }

    const model = getUserModel(msg);
    lines.push(`Model: ${model || 'default'}`);
    lines.push(`Uptime: ${uptimeHr}h ${uptimeMin % 60}m`);
    lines.push('');
    lines.push('Tip: <code>/save &lt;name&gt;</code> to label this session for easy recall');

    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  // v1.6.0: /interrupt — cancel the in-flight Claude subprocess for this chat.
  // Safe to call when nothing is running; we just say so.
  bot.onText(/\/interrupt|\/stop|\/cancel/, (msg) => {
    const key = sessionKey(msg);
    const result = _claudeCli().interruptJob(key);
    if (!result.interrupted) {
      bot.sendMessage(msg.chat.id, 'No active Claude job to interrupt. (Nothing was running.)');
      return;
    }
    log.info('/interrupt command', {
      chatId: msg.chat.id,
      userId: msg.from.id,
      sessionId: result.sessionId?.slice(0, 8),
      elapsedMs: result.elapsedMs,
    });
    bot.sendMessage(msg.chat.id,
      `⏹ Interrupt sent. Claude was running for ${Math.round(result.elapsedMs / 1000)}s — ` +
      `your session is preserved and anything Claude finished before the interrupt is already saved.`,
      { parse_mode: 'HTML' }
    );
  });

  // v1.6.0: /cost — last turn + cumulative session cost (from Claude's JSON output)
  bot.onText(/\/cost/, (msg) => {
    const session = getSession(msg);
    if (!session?.sessionId) {
      bot.sendMessage(msg.chat.id, 'No active session. Cost starts tracking on your first message.');
      return;
    }
    const last = typeof session.lastCostUsd === 'number' ? `$${session.lastCostUsd.toFixed(4)}` : '—';
    const total = typeof session.totalCostUsd === 'number' ? `$${session.totalCostUsd.toFixed(4)}` : '—';
    const lines = [
      '<b>Session Cost</b>',
      '',
      `Last turn: ${last}`,
      `Session total: ${total}`,
      `Messages counted: ${session.messageCount || 0}`,
      '',
      '<i>Cost comes straight from Claude CLI\'s <code>total_cost_usd</code> field. ' +
      'On a Max subscription this is usually $0.00 — per-API-key runs will show real amounts.</i>',
    ];
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  // /export — dump the current session as a Markdown file and send as a document
  bot.onText(/\/export/, async (msg) => {
    const chatId = msg.chat.id;
    const session = getSession(msg);
    if (!session?.sessionId) {
      await bot.sendMessage(chatId,
        'No active session to export. Start a conversation first, then run /export.'
      );
      return;
    }

    bot.sendChatAction(chatId, 'upload_document').catch(() => {});

    try {
      const { path: outPath, size } = await exportSession(session.sessionId);
      // Send with a .txt-extension filename and text/plain MIME type so
      // mobile clients (especially Android) route taps to a native text
      // viewer instead of punting to a generic share sheet. The file
      // contents are still Markdown — anyone who wants to render them
      // can rename to .md, but inside the chat the text is readable as-is.
      const filename = `session-${session.sessionId.slice(0, 8)}.txt`;
      await bot.sendDocument(
        chatId,
        outPath,
        {
          caption: `Session ${session.sessionId.slice(0, 8)} (${Math.round(size / 1024)}KB) — Markdown transcript`,
        },
        {
          filename,
          contentType: 'text/plain',
        }
      );
      log.info('/export command', {
        chatId,
        userId: msg.from.id,
        sessionId: session.sessionId.slice(0, 8),
        sizeBytes: size,
      });
    } catch (err) {
      log.error('/export error', { error: err.message });
      await bot.sendMessage(chatId, `Export failed: ${err.message}`);
    }
  });

  bot.onText(/\/model(?:\s+(.+))?/, (msg, match) => {
    const newModel = match[1]?.trim();
    if (!newModel) {
      const current = getUserModel(msg);
      bot.sendMessage(msg.chat.id, `Current model: <b>${current || 'default'}</b>`, { parse_mode: 'HTML' });
      return;
    }
    if (newModel === 'default' || newModel === 'reset') {
      setUserModel(msg, null);
      bot.sendMessage(msg.chat.id, 'Model reset to default.');
    } else {
      setUserModel(msg, newModel);
      bot.sendMessage(msg.chat.id, `Model set to <b>${newModel}</b>`, { parse_mode: 'HTML' });
    }
    log.info('/model command', { chatId: msg.chat.id, model: newModel });
  });
}

module.exports = {
  registerCommands,
  getPassthroughPrompt,
  // Exposed so bot.js can conditionally publish /memory in setMyCommands and
  // tests can verify the detection state.
  isOpenclawAvailable: () => OPENCLAW !== null,
};
