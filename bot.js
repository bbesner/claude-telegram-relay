// quiet: true suppresses the "[dotenv@17.x.x] injected env (N) from .env"
// startup line that dotenv 17 prints by default. Our logs are already JSON-
// structured via lib/logger, so we don't want an unstructured line leaking
// into pm2's stdout stream.
require('dotenv').config({ quiet: true });

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { isAuthorized } = require('./lib/auth');
const { invokeClaude, streamClaude } = require('./lib/claude-cli');
const { formatResponse } = require('./lib/formatter');
const { createRenderer } = require('./lib/stream-renderer');
const {
  getSession,
  setSession,
  getUserModel,
  sessionKey,
  markSessionError,
  recordCost,
} = require('./lib/session-manager');
const { sessionFileExists } = require('./lib/session-browser');
const { enqueue } = require('./lib/message-queue');
const { registerCommands, getPassthroughPrompt, isOpenclawAvailable, notifyCompletion } = require('./lib/commands');
const jobRunner = require('./lib/job-runner');
const { registerCallbackHandlers, buildResponseKeyboard, handleSaveReplyIfPresent } = require('./lib/callbacks');
const { downloadTelegramFile, extractMediaInfo, buildMediaPrompt, extractCreatedFiles } = require('./lib/media');
const { startPeriodicCheck: startUpdateCheck } = require('./lib/update-checker');
const log = require('./lib/logger');

// --- Validate required config ---
if (!process.env.TELEGRAM_BOT_TOKEN) {
  log.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}
if (!process.env.ALLOWED_USER_IDS) {
  log.error('ALLOWED_USER_IDS is required');
  process.exit(1);
}

const GROUP_MODE = process.env.GROUP_MODE || 'mention';

// --- Create bot with polling ---
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
let botInfo;

// Commands published to Telegram so they appear in the native `/` autocomplete
// and the "Menu" button next to the chat input. Stored on Telegram's side, so
// one call per deploy is enough. /memory is appended only when OpenClaw is
// detected, so standalone users never see it.
const BOT_COMMANDS = [
  { command: 'sessions', description: 'List recent Claude Code sessions' },
  { command: 'resume',   description: 'Resume a session by #, ID, or label' },
  { command: 'save',     description: 'Label the current session for easy recall' },
  { command: 'new',      description: 'Clear session, start a fresh conversation' },
  { command: 'info',     description: 'Show current session ID, messages, uptime' },
  { command: 'cost',     description: 'Show cost for the current session' },
  { command: 'interrupt',description: 'Cancel the in-flight Claude request' },
  { command: 'run',      description: 'Start a background job (survives long tasks)' },
  { command: 'jobs',     description: 'List recent background jobs' },
  { command: 'job',      description: 'Show details for one background job' },
  { command: 'export',   description: 'Export current session as a Markdown file' },
  { command: 'model',    description: 'Show or set model (sonnet, opus, haiku)' },
  { command: 'status',   description: 'Full server status (PM2, disk, memory)' },
  { command: 'logs',     description: 'Show recent logs for a PM2 service' },
  { command: 'restart',  description: 'Restart a PM2 service' },
  { command: 'deploy',   description: 'Deploy a site via SSH' },
  { command: 'help',     description: 'Show all commands' },
  { command: 'start',    description: 'Welcome message and command list' },
];
if (isOpenclawAvailable()) {
  BOT_COMMANDS.splice(6, 0, { command: 'memory', description: 'Search OpenClaw memory (no AI tokens)' });
}

bot.getMe().then((me) => {
  botInfo = me;
  log.info('Bot started', { username: me.username, id: me.id });
  log.info('claude-telegram-relay by Brad Besner (github.com/bbesner/claude-telegram-relay)');

  // Publish the command list to Telegram so users get a native / autocomplete.
  bot.setMyCommands(BOT_COMMANDS)
    .then(() => log.info('Published bot command menu', { count: BOT_COMMANDS.length }))
    .catch((err) => log.warn('setMyCommands failed', { error: err.message }));

  // Send startup notification if configured
  if (process.env.SEND_STARTUP_MESSAGE === 'true') {
    const userIds = process.env.ALLOWED_USER_IDS.split(',').map(id => id.trim());
    for (const uid of userIds) {
      bot.sendMessage(uid, `Claude Code Relay is online. (@${me.username})\n\nBuilt by Brad Besner · https://github.com/bbesner/claude-telegram-relay`).catch(() => {});
    }
  }

  // v1.8.0: reconcile background jobs that were running when we last shut
  // down. Any job whose subprocess is still alive gets a fresh watcher;
  // any whose subprocess finished during the outage fires a belated
  // completion notification to its originating chat.
  try {
    const rec = jobRunner.reconcileOnStartup({
      onResume: (job) => {
        log.info('Job reconciled — still running', { jobId: job.jobId, pid: job.pid });
        // Quietly tell the user we picked back up. Avoids a surprise
        // completion message later with no context.
        bot.sendMessage(job.chatId,
          `🔄 Background job <code>${job.jobId}</code> is still running — I'll message when it's done.`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      },
      onComplete: (job) => {
        log.info('Job reconciled — finalized at startup', { jobId: job.jobId, state: job.state });
        notifyCompletion(bot, job).catch((e) => {
          log.warn('Reconciliation notifyCompletion failed', { jobId: job.jobId, error: e.message });
        });
      },
    });
    if (rec && (rec.reAttached > 0 || rec.finalized > 0)) {
      log.info('Job reconciliation summary', rec);
    }
  } catch (e) {
    log.warn('Job reconciliation threw', { error: e.message });
  }

  // v1.5.0+: start the update checker. Runs once now (async, non-blocking)
  // and then every 24 hours. Notifies the first ALLOWED_USER_IDS entry
  // when a newer release is published on GitHub. Opt out with
  // UPDATE_CHECK=false in .env.
  const adminId = process.env.ALLOWED_USER_IDS.split(',')[0].trim();
  startUpdateCheck({
    sendMessage: (text) => bot.sendMessage(adminId, text, { parse_mode: 'HTML', disable_web_page_preview: true }),
  });
});

// --- Register commands ---
const BOT_START_TIME = Date.now();
registerCommands(bot);
registerCallbackHandlers(bot, BOT_START_TIME);

// --- Main message handler ---
bot.on('message', async (msg) => {
  // Check if this is a reply to a 💾 Save prompt from an inline keyboard tap
  // — if so, the callbacks module handles it and we skip Claude entirely.
  if (await handleSaveReplyIfPresent(bot, msg)) return;

  // Check for pass-through commands (e.g. /status, /logs, /restart, /deploy)
  const passthrough = msg.text ? getPassthroughPrompt(msg.text) : null;

  // Skip bot-handled commands (e.g. /new, /help, /info, /model, /start)
  if (msg.text && msg.text.startsWith('/') && !passthrough) return;

  // Check for media or text
  const mediaInfo = extractMediaInfo(msg);
  if (!msg.text && !mediaInfo) return;

  // Auth check
  if (!isAuthorized(msg.from.id)) {
    log.debug('Unauthorized message', { userId: msg.from.id, username: msg.from.username });
    return;
  }

  // Group chat filtering
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  if (isGroup && GROUP_MODE === 'mention') {
    const msgText = msg.text || msg.caption || '';
    const isMentioned = botInfo && msgText.includes(`@${botInfo.username}`);
    const isReply = msg.reply_to_message && msg.reply_to_message.from?.id === botInfo?.id;
    if (!isMentioned && !isReply) return;

    // Strip the @mention from the text
    if (isMentioned && botInfo) {
      if (msg.text) msg.text = msg.text.replace(`@${botInfo.username}`, '').trim();
      if (msg.caption) msg.caption = msg.caption.replace(`@${botInfo.username}`, '').trim();
    }
  }

  const chatKey = sessionKey(msg);
  const chatId = msg.chat.id;

  // v1.7.0: streaming is on by default. Set STREAMING=false in .env to fall
  // back to the v1.6.0 synchronous invokeClaude path (a useful escape hatch
  // if stream-json ever changes shape in a future Claude Code release).
  const STREAMING = (process.env.STREAMING || 'true').toLowerCase() !== 'false';

  try {
    await enqueue(chatKey, async () => {
      // Pre-stream typing indicator. Once the renderer seeds a message the
      // "typing" action is redundant, but the user sees SOMETHING immediately
      // in the ~200ms before the first event arrives.
      bot.sendChatAction(chatId, 'typing').catch(() => {});
      const typingInterval = setInterval(() => {
        bot.sendChatAction(chatId, 'typing').catch(() => {});
      }, 4000);

      try {
        const session = getSession(msg);
        const model = getUserModel(msg);
        const chatKeyLocal = sessionKey(msg);

        // v1.6.0 preflight: if we think we have an active session but the
        // JSONL file is gone (Claude cleanup, external rm, bad state), warn
        // the user BEFORE we spawn Claude. This avoids the common "resume
        // silently fails, bot silently starts fresh" trap.
        if (session?.sessionId && !sessionFileExists(session.sessionId)) {
          log.warn('Resume preflight: session file missing', {
            chatId,
            sessionId: session.sessionId.slice(0, 8),
          });
          markSessionError(msg, 'session file missing at preflight', { kind: 'resume-failed' });
          clearInterval(typingInterval);
          await bot.sendMessage(chatId,
            `<b>⚠ Previous session can no longer be resumed</b>\n\n` +
            `Session <code>${session.sessionId.slice(0, 8)}</code> is no longer on disk — ` +
            `its transcript has been removed or is unreadable. Prior context is <b>not</b> available.\n\n` +
            `Choose one:\n` +
            `• <code>/new</code> — start a fresh conversation (your message is not sent yet)\n` +
            `• <code>/sessions</code> then <code>/resume &lt;n&gt;</code> — pick a different thread\n\n` +
            `Then re-send your message.`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        // Build prompt — handle pass-through commands, media, or plain text
        let prompt;
        if (passthrough) {
          prompt = passthrough.prompt;
          log.info('Pass-through command', { chatId, command: msg.text });
        } else if (mediaInfo) {
          try {
            const localPath = await downloadTelegramFile(bot, mediaInfo.fileId, mediaInfo.fileName);
            prompt = buildMediaPrompt(localPath, mediaInfo.type, msg.caption || msg.text);
            log.info('Processing media message', {
              chatId,
              userId: msg.from.id,
              type: mediaInfo.type,
              fileName: mediaInfo.fileName,
              localPath,
            });
          } catch (dlErr) {
            clearInterval(typingInterval);
            await bot.sendMessage(chatId, `Failed to download file: ${dlErr.message}`);
            return;
          }
        } else {
          prompt = msg.text;
        }

        log.info('Processing message', {
          chatId,
          userId: msg.from.id,
          sessionId: session?.sessionId?.slice(0, 8),
          promptLength: prompt.length,
          hasMedia: !!mediaInfo,
        });

        // v1.7.0: use the streaming path for chat messages; renderer owns
        // the seed message + live edits. Pass-through commands and media
        // messages reuse this same path — they all benefit from a visible
        // "Claude is reading…" indicator.
        let renderer = null;
        let response;
        if (STREAMING) {
          renderer = createRenderer(bot, chatId, {
            replyTo: msg.message_id,
            keyboardBuilder: () => buildResponseKeyboard(),
          });
          response = await streamClaude(prompt, {
            sessionId: session?.sessionId,
            model: model || undefined,
            chatKey: chatKeyLocal,
            onEvent: (evt) => renderer.onEvent(evt),
          });
        } else {
          response = await invokeClaude(prompt, {
            sessionId: session?.sessionId,
            model: model || undefined,
            chatKey: chatKeyLocal,
          });
        }

        clearInterval(typingInterval);

        // v1.7.0: route error text through the renderer so the live seed
        // message gets replaced with the explanation instead of leaving a
        // "Thinking…" placeholder behind. When STREAMING is off, the
        // renderer is null and we fall back to sendMessage.
        const sendError = async (htmlBody) => {
          if (renderer) await renderer.finalizeError(htmlBody);
          else          await bot.sendMessage(chatId, htmlBody, { parse_mode: 'HTML' });
        };

        if (response.error) {
          // v1.6.0: never silently swap to a fresh session. If resume failed,
          // tell the user exactly what happened and let them pick a recovery.
          const looksLikeResumeFail =
            session?.sessionId &&
            (response.error.toLowerCase().includes('session') ||
             response.error.toLowerCase().includes('resume'));

          if (response.interrupted) {
            markSessionError(msg, 'interrupted by user', { kind: 'error' });
            await sendError(
              `⏹ <b>Request cancelled.</b> Claude was stopped before it finished. ` +
              `Your session is unchanged; send a new message to continue.`
            );
            return;
          }

          if (response.timedOut) {
            const timeoutSec = Math.round((parseInt(process.env.CLAUDE_TIMEOUT_MS || '120000', 10)) / 1000);
            markSessionError(msg, `timeout after ${timeoutSec}s`, { kind: 'timeout' });
            await sendError(
              `⌛ <b>Timed out after ${timeoutSec}s.</b>\n\n` +
              `The task was <b>terminated</b> — it is <i>not</i> still running in the background. ` +
              `Anything Claude was mid-way through (edits, commands, tool calls) may be in a partial state.\n\n` +
              `• Try again with a smaller scope, or\n` +
              `• Increase <code>CLAUDE_TIMEOUT_MS</code> in <code>.env</code> if you expect this to take longer.\n\n` +
              `Your session is preserved — send another message to continue.`
            );
            return;
          }

          if (looksLikeResumeFail) {
            markSessionError(msg, response.error, { kind: 'resume-failed' });
            log.warn('Session resume failed — NOT auto-replacing', {
              chatId,
              sessionId: session.sessionId.slice(0, 8),
              error: response.error,
            });
            await sendError(
              `<b>⚠ Couldn't resume your previous session</b>\n\n` +
              `Session <code>${session.sessionId.slice(0, 8)}</code> failed to resume:\n` +
              `<code>${escapeForHtml(response.error).slice(0, 300)}</code>\n\n` +
              `Prior context is <b>not</b> guaranteed. Choose one:\n` +
              `• <code>/new</code> — drop this session and start fresh\n` +
              `• <code>/sessions</code> then <code>/resume &lt;n&gt;</code> — pick a different thread\n\n` +
              `Nothing was sent to a new session automatically.`
            );
            return;
          }

          markSessionError(msg, response.error, { kind: 'error' });
          await sendError(`Error: ${escapeForHtml(response.error)}`);
          return;
        }

        // Update session
        if (response.sessionId) {
          setSession(msg, response.sessionId);
        }
        // Record cost (v1.6.0) for /cost reporting
        recordCost(msg, response.cost);

        // Send text response — streaming path swaps the seed placeholder for
        // the formatted answer; non-streaming path uses the old chunking fn.
        if (renderer) {
          await renderer.finalize({ text: response.result || '' });
        } else {
          await sendChunkedResponse(chatId, response.result, msg.message_id);
        }

        // Check if Claude created any files and send them back
        const createdFiles = extractCreatedFiles(response.result);
        for (const filePath of createdFiles) {
          try {
            const ext = path.extname(filePath).toLowerCase();
            const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);

            if (isImage) {
              await bot.sendPhoto(chatId, filePath, { caption: path.basename(filePath) });
            } else {
              await bot.sendDocument(chatId, filePath, { caption: path.basename(filePath) });
            }
            log.info('Sent file to Telegram', { filePath });
          } catch (sendErr) {
            log.warn('Failed to send file', { filePath, error: sendErr.message });
          }
        }

        log.info('Response sent', {
          chatId,
          sessionId: response.sessionId?.slice(0, 8),
          cost: response.cost,
          responseLength: response.result?.length,
          filesSent: createdFiles.length,
          streamed: !!renderer,
          toolsUsed: response.toolsUsed || [],
        });
      } finally {
        clearInterval(typingInterval);
      }
    });
  } catch (err) {
    // Queue overflow
    await bot.sendMessage(chatId, err.message).catch(() => {});
  }
});

/**
 * Send a response, chunking if necessary.
 * First chunk replies to the original message; subsequent chunks are standalone.
 * Inline keyboard buttons (v1.4.0) are attached to the LAST chunk only, so
 * there's one clean action row at the end of the conversation instead of
 * buttons floating in the middle of a multi-part response.
 */
async function sendChunkedResponse(chatId, text, replyToId) {
  if (!text) {
    const opts = {};
    const kb = buildResponseKeyboard();
    if (kb) opts.reply_markup = kb;
    await bot.sendMessage(chatId, '(empty response)', opts);
    return;
  }

  const chunks = formatResponse(text);
  const keyboard = buildResponseKeyboard();

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const opts = { parse_mode: 'HTML' };
    if (i === 0 && replyToId) {
      opts.reply_to_message_id = replyToId;
    }
    if (isLast && keyboard) {
      opts.reply_markup = keyboard;
    }
    try {
      await bot.sendMessage(chatId, chunks[i], opts);
    } catch (e) {
      // If HTML parse fails, fall back to plain text
      if (e.message?.includes('parse')) {
        const plainOpts = {};
        if (i === 0 && replyToId) plainOpts.reply_to_message_id = replyToId;
        if (isLast && keyboard) plainOpts.reply_markup = keyboard;
        await bot.sendMessage(chatId, chunks[i].replace(/<[^>]+>/g, ''), plainOpts);
      } else {
        throw e;
      }
    }
  }
}

// v1.6.0: escape user-visible error text before embedding it in an HTML message.
function escapeForHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- Graceful shutdown ---
function shutdown(signal) {
  log.info('Shutting down', { signal });
  bot.stopPolling();
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Error handling ---
bot.on('polling_error', (err) => {
  log.error('Polling error', { error: err.message });
});

process.on('unhandledRejection', (err) => {
  log.error('Unhandled rejection', { error: err.message || String(err) });
});
