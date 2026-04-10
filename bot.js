require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { isAuthorized } = require('./lib/auth');
const { invokeClaude } = require('./lib/claude-cli');
const { formatResponse } = require('./lib/formatter');
const { getSession, setSession, getUserModel, sessionKey } = require('./lib/session-manager');
const { enqueue } = require('./lib/message-queue');
const { registerCommands, getPassthroughPrompt } = require('./lib/commands');
const { downloadTelegramFile, extractMediaInfo, buildMediaPrompt, extractCreatedFiles } = require('./lib/media');
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
// one call per deploy is enough.
const BOT_COMMANDS = [
  { command: 'sessions', description: 'List recent Claude Code sessions' },
  { command: 'resume',   description: 'Resume a session by #, ID, or label' },
  { command: 'save',     description: 'Label the current session for easy recall' },
  { command: 'new',      description: 'Clear session, start a fresh conversation' },
  { command: 'info',     description: 'Show current session ID, messages, uptime' },
  { command: 'model',    description: 'Show or set model (sonnet, opus, haiku)' },
  { command: 'status',   description: 'Full server status (PM2, disk, memory)' },
  { command: 'logs',     description: 'Show recent logs for a PM2 service' },
  { command: 'restart',  description: 'Restart a PM2 service' },
  { command: 'deploy',   description: 'Deploy a site via SSH' },
  { command: 'help',     description: 'Show all commands' },
  { command: 'start',    description: 'Welcome message and command list' },
];

bot.getMe().then((me) => {
  botInfo = me;
  log.info('Bot started', { username: me.username, id: me.id });

  // Publish the command list to Telegram so users get a native / autocomplete.
  bot.setMyCommands(BOT_COMMANDS)
    .then(() => log.info('Published bot command menu', { count: BOT_COMMANDS.length }))
    .catch((err) => log.warn('setMyCommands failed', { error: err.message }));

  // Send startup notification if configured
  if (process.env.SEND_STARTUP_MESSAGE === 'true') {
    const userIds = process.env.ALLOWED_USER_IDS.split(',').map(id => id.trim());
    for (const uid of userIds) {
      bot.sendMessage(uid, `Claude Code Relay is online. (@${me.username})`).catch(() => {});
    }
  }
});

// --- Register commands ---
registerCommands(bot);

// --- Main message handler ---
bot.on('message', async (msg) => {
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

  try {
    await enqueue(chatKey, async () => {
      // Send typing indicator
      bot.sendChatAction(chatId, 'typing').catch(() => {});

      // Keep typing indicator alive for long requests
      const typingInterval = setInterval(() => {
        bot.sendChatAction(chatId, 'typing').catch(() => {});
      }, 4000);

      try {
        const session = getSession(msg);
        const model = getUserModel(msg);

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

        const response = await invokeClaude(prompt, {
          sessionId: session?.sessionId,
          model: model || undefined,
        });

        clearInterval(typingInterval);

        if (response.error) {
          // If resume failed, try without session
          if (session?.sessionId && response.error.includes('session')) {
            log.warn('Session resume failed, starting fresh', { error: response.error });
            const retry = await invokeClaude(prompt, { model: model || undefined });
            if (retry.error) {
              await bot.sendMessage(chatId, `Error: ${retry.error}`);
              return;
            }
            if (retry.sessionId) setSession(msg, retry.sessionId);
            await sendChunkedResponse(chatId, retry.result, msg.message_id);
            return;
          }
          await bot.sendMessage(chatId, `Error: ${response.error}`);
          return;
        }

        // Update session
        if (response.sessionId) {
          setSession(msg, response.sessionId);
        }

        // Send text response
        await sendChunkedResponse(chatId, response.result, msg.message_id);

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
 */
async function sendChunkedResponse(chatId, text, replyToId) {
  if (!text) {
    await bot.sendMessage(chatId, '(empty response)');
    return;
  }

  const chunks = formatResponse(text);

  for (let i = 0; i < chunks.length; i++) {
    const opts = { parse_mode: 'HTML' };
    if (i === 0 && replyToId) {
      opts.reply_to_message_id = replyToId;
    }
    try {
      await bot.sendMessage(chatId, chunks[i], opts);
    } catch (e) {
      // If HTML parse fails, fall back to plain text
      if (e.message?.includes('parse')) {
        const plainOpts = {};
        if (i === 0 && replyToId) plainOpts.reply_to_message_id = replyToId;
        await bot.sendMessage(chatId, chunks[i].replace(/<[^>]+>/g, ''), plainOpts);
      } else {
        throw e;
      }
    }
  }
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
