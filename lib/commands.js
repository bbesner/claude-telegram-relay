const {
  clearSession,
  getSession,
  setSession,
  setSessionById,
  getUserModel,
  setUserModel,
  saveSessionLabel,
  getSessionByLabel,
  getAllRelaySessionIds,
  setSessionListing,
  getSessionFromListing,
  sessionKey,
  recordCost,
} = require('./session-manager');
const { listAllSessions, formatSessionList, sessionFileExists } = require('./session-browser');
const jm = require('./job-manager');
// Lazy-load claude-cli and job-runner — both perform a binary lookup at
// module load and can block test-only imports of commands.js.
function _claudeCli() { return require('./claude-cli'); }
function _jobRunner() { return require('./job-runner'); }
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

/**
 * v1.8.0: send a "job done" notification to the originating chat. Shared by
 * /run's onComplete hook and bot.js's startup reconciliation so the message
 * format stays identical in both paths.
 *
 * @param {object} bot — node-telegram-bot-api
 * @param {object} job — the final job record from job-manager
 * @param {object} [originalMsg] — the Telegram message that spawned /run.
 *        Used to route session state updates; optional for reconciliation.
 */
async function notifyCompletion(bot, job, originalMsg) {
  if (!job) return;
  const chatId = job.chatId;

  // Icons keep the state visually scannable on a phone.
  const icon = ({
    completed: '✅', failed: '❌', timed_out: '⌛',
    cancelled: '⏹', orphaned: '🚫',
  }[job.state] || '•');

  // Session update: treat a successful background job the same as a
  // successful foreground turn — advances the chat's session pointer and
  // records cost against the session total.
  if (job.state === 'completed' && job.sessionId && originalMsg) {
    try { setSession(originalMsg, job.sessionId); } catch (e) { /* ignore */ }
    try { require('./session-manager').recordCost(originalMsg, job.cost); } catch (e) { /* ignore */ }
  }

  // Header first so it works for both happy path and errors.
  const header =
    `${icon} <b>Background job ${job.state}</b> — <code>${job.jobId}</code>` +
    (typeof job.durationMs === 'number' ? ` · ${Math.round(job.durationMs / 1000)}s` : '') +
    (typeof job.cost === 'number' && job.cost > 0 ? ` · $${job.cost.toFixed(4)}` : '') +
    (job.toolsUsed?.length ? ` · tools: ${job.toolsUsed.join(', ')}` : '');

  try {
    await bot.sendMessage(chatId, header, { parse_mode: 'HTML' });
  } catch (e) { log.warn('notifyCompletion header send failed', { error: e.message }); }

  const { formatResponse } = require('./formatter');

  if (job.state === 'completed' && job.result) {
    const chunks = formatResponse(job.result);
    for (const chunk of chunks) {
      try { await bot.sendMessage(chatId, chunk, { parse_mode: 'HTML' }); }
      catch (e) {
        if (/parse/i.test(e.message || '')) {
          await bot.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ''));
        } else {
          log.warn('notifyCompletion chunk send failed', { error: e.message });
        }
      }
    }
  } else if (job.error) {
    const body =
      `<code>${escapeHtml(job.error.slice(0, 600))}</code>\n\n` +
      `<i>Use</i> <code>/job ${job.jobId}</code> <i>for details.</i>`;
    try { await bot.sendMessage(chatId, body, { parse_mode: 'HTML' }); }
    catch (e) { log.warn('notifyCompletion error-body send failed', { error: e.message }); }
  }
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

  // v1.8.0: /run <prompt> — start a background job that survives the relay's
  // 8-minute synchronous request window. One job per chat at a time.
  bot.onText(/\/run(?:\s+([\s\S]+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const chatKey = sessionKey(msg);
    const prompt = match[1]?.trim();
    if (!prompt) {
      await bot.sendMessage(chatId,
        'Usage: <code>/run &lt;prompt&gt;</code>\n\n' +
        'Starts a background job that keeps running even if it takes longer than ' +
        'the normal 8-minute request window. You\'ll get a message when it\'s done.\n\n' +
        'Check status with <code>/jobs</code> or <code>/job &lt;id&gt;</code>, cancel with ' +
        '<code>/cancel &lt;id&gt;</code>.',
        { parse_mode: 'HTML' }
      );
      return;
    }
    const existing = jm.getActiveJobForChat(chatKey);
    if (existing) {
      await bot.sendMessage(chatId,
        `Already have a background job running in this chat: <code>${existing.jobId}</code>.\n` +
        `Cancel it with <code>/cancel ${existing.jobId}</code> or wait for it to finish.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const session = getSession(msg);
    const model = getUserModel(msg);

    const job = _jobRunner().startJob({
      prompt,
      chatKey,
      chatId,
      sessionId: session?.sessionId,
      model: model || undefined,
      workingDir: process.env.WORKING_DIR || process.env.HOME,
      onComplete: (finalJob) => {
        notifyCompletion(bot, finalJob, msg).catch((e) => {
          log.warn('notifyCompletion threw', { jobId: finalJob.jobId, error: e.message });
        });
      },
    });

    await bot.sendMessage(chatId,
      `🚀 <b>Background job started</b>\n\n` +
      `ID: <code>${job.jobId}</code>\n` +
      (job.sessionId ? `Session: <code>${job.sessionId.slice(0, 8)}</code>\n` : '') +
      `\nI'll send you the result when it's done. Meanwhile you can still chat normally — ` +
      `this job runs in the background.\n\n` +
      `<code>/jobs</code> · <code>/job ${job.jobId}</code> · <code>/cancel ${job.jobId}</code>`,
      { parse_mode: 'HTML' }
    );
    log.info('/run command', { chatId, userId: msg.from.id, jobId: job.jobId });
  });

  // v1.8.0: /jobs — list recent background jobs for this chat
  bot.onText(/\/jobs$|\/jobs\s/, async (msg) => {
    const chatKey = sessionKey(msg);
    const list = jm.getJobsForChat(chatKey, { limit: 10 });
    if (list.length === 0) {
      await bot.sendMessage(msg.chat.id,
        'No background jobs yet. Start one with <code>/run &lt;prompt&gt;</code>.',
        { parse_mode: 'HTML' }
      );
      return;
    }
    const icon = (s) => ({
      queued: '⏳', running: '🔄', completed: '✅',
      failed: '❌', timed_out: '⌛', cancelled: '⏹', orphaned: '🚫',
    }[s] || '•');
    const lines = ['<b>Background jobs</b>', ''];
    for (const j of list) {
      lines.push(`${icon(j.state)} <code>${j.jobId}</code> — ${j.state}`);
      if (j.promptPreview) lines.push(`   <i>${escapeHtml(j.promptPreview.slice(0, 80))}</i>`);
      if (j.state === 'running' && j.lastStatus) lines.push(`   <i>${escapeHtml(j.lastStatus)}</i>`);
      lines.push('');
    }
    lines.push('<i>Details: <code>/job &lt;id&gt;</code> · Cancel running: <code>/cancel &lt;id&gt;</code></i>');
    await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  // v1.8.0: /job <id> — inspect a single job
  bot.onText(/\/job(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const id = match[1]?.trim();
    if (!id) {
      await bot.sendMessage(chatId, 'Usage: <code>/job &lt;id&gt;</code>', { parse_mode: 'HTML' });
      return;
    }
    const j = jm.getJob(id);
    if (!j) {
      await bot.sendMessage(chatId, `No job with id <code>${escapeHtml(id)}</code>.`, { parse_mode: 'HTML' });
      return;
    }
    const lines = [`<b>Job</b> <code>${j.jobId}</code>`, ''];
    lines.push(`State: <b>${j.state}</b>`);
    if (j.sessionId)      lines.push(`Session: <code>${j.sessionId.slice(0, 8)}</code>`);
    if (j.model)          lines.push(`Model: ${j.model}`);
    if (j.pid)            lines.push(`PID: ${j.pid}`);
    if (j.createdAt)      lines.push(`Created: ${j.createdAt}`);
    if (j.startedAt)      lines.push(`Started: ${j.startedAt}`);
    if (j.finishedAt)     lines.push(`Finished: ${j.finishedAt}`);
    if (typeof j.durationMs === 'number') lines.push(`Duration: ${Math.round(j.durationMs / 1000)}s`);
    if (typeof j.cost === 'number')       lines.push(`Cost: $${j.cost.toFixed(4)}`);
    if (j.toolsUsed?.length)              lines.push(`Tools: ${j.toolsUsed.join(', ')}`);
    if (j.state === 'running' && j.lastStatus) lines.push(`Status: <i>${escapeHtml(j.lastStatus)}</i>`);
    if (j.error)          lines.push(`Error: <code>${escapeHtml(j.error.slice(0, 300))}</code>`);
    if (j.promptPreview)  lines.push(`\n<i>${escapeHtml(j.promptPreview)}</i>`);
    await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  });

  // v1.8.0: /cancel <id> — SIGTERM a running job
  bot.onText(/\/cancel(?:\s+(\S+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const id = match[1]?.trim();
    if (!id) {
      // Without an id, /cancel behaves like /interrupt — cancel the
      // foreground subprocess for this chat. Mirrors the v1.6.0 alias.
      const result = _claudeCli().interruptJob(sessionKey(msg));
      if (!result.interrupted) {
        await bot.sendMessage(chatId,
          'Usage: <code>/cancel &lt;job-id&gt;</code>\n\n' +
          'With no id, cancels any in-flight foreground request (alias for <code>/interrupt</code>). ' +
          'Nothing is currently running.',
          { parse_mode: 'HTML' }
        );
      } else {
        await bot.sendMessage(chatId,
          `⏹ Interrupt sent. Foreground Claude was running for ${Math.round(result.elapsedMs / 1000)}s.`,
          { parse_mode: 'HTML' }
        );
      }
      return;
    }
    const ok = _jobRunner().cancelJob(id);
    if (!ok) {
      const j = jm.getJob(id);
      if (!j) {
        await bot.sendMessage(chatId, `No job with id <code>${escapeHtml(id)}</code>.`, { parse_mode: 'HTML' });
      } else {
        await bot.sendMessage(chatId,
          `Job <code>${j.jobId}</code> is already <b>${j.state}</b>, nothing to cancel.`,
          { parse_mode: 'HTML' }
        );
      }
      return;
    }
    await bot.sendMessage(chatId,
      `⏹ Cancel requested for <code>${id}</code>. Claude should exit within a few seconds.`,
      { parse_mode: 'HTML' }
    );
    log.info('/cancel command', { chatId, userId: msg.from.id, jobId: id });
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
  // v1.8.0: bot.js uses this to deliver belated completions after a restart.
  notifyCompletion,
};
