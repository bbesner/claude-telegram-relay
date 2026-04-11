// ============================================================================
// lib/callbacks.js — Inline keyboard callback handling (v1.4.0+).
//
// Attaches a three-button keyboard under every Claude response and routes
// button taps to the same logic as the slash-command equivalents.
//
// Buttons:
//   [+ New]     — calls /new (clearSession)
//   [💾 Save]    — prompts the user for a label, then calls /save
//   [ℹ Info]    — calls /info
//
// Controlled by INLINE_KEYBOARDS env var (default: true). Set to "false"
// to disable — the rest of the bot is unaffected.
//
// Implementation notes:
//   - Callback data is kept short (<=16 bytes) because Telegram caps
//     callback_data at 64 bytes.
//   - The Save flow uses Telegram's ForceReply to target the user's next
//     text message at the save prompt without cluttering the chat.
//   - A `savePromptIds` Map tracks outstanding save prompts per chat so
//     we can recognize incoming replies that match them, label the
//     current session, and confirm.
// ============================================================================

const {
  clearSession,
  getSession,
  saveSessionLabel,
  getUserModel,
} = require('./session-manager');
const log = require('./logger');

// Env flag — read once at module load, not per-call
const INLINE_KEYBOARDS_ENABLED = process.env.INLINE_KEYBOARDS !== 'false';

// Callback-data strings. Keep short.
const CB = {
  NEW:  'rly:new',
  SAVE: 'rly:save',
  INFO: 'rly:info',
};

// Map<chatId, { messageId, expiresAt }> — outstanding save prompts.
// Used so the message handler can recognize a user reply to the save prompt
// and route it through saveSessionLabel instead of to Claude.
const savePromptIds = new Map();
const SAVE_PROMPT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns the Telegram reply_markup object for a response, or undefined
 * when inline keyboards are disabled. Attach this to the LAST chunk of a
 * chunked response so the buttons appear at the end of Claude's reply.
 */
function buildResponseKeyboard() {
  if (!INLINE_KEYBOARDS_ENABLED) return undefined;
  return {
    inline_keyboard: [[
      { text: '+ New',   callback_data: CB.NEW  },
      { text: '💾 Save', callback_data: CB.SAVE },
      { text: 'ℹ Info',  callback_data: CB.INFO },
    ]],
  };
}

/**
 * Format the /info payload the same way the slash command does, so callback
 * taps and typed commands produce identical output.
 */
function formatInfo(msg, session, startTime) {
  const uptimeMs = Date.now() - startTime;
  const uptimeMin = Math.floor(uptimeMs / 60000);
  const uptimeHr = Math.floor(uptimeMin / 60);

  const lines = ['<b>Session Info</b>', ''];
  if (session?.sessionId) {
    lines.push(`Session: <code>${session.sessionId}</code>`);
    lines.push(`Messages: ${session.messageCount || 0}`);
    lines.push(`Started: ${session.startedAt || 'unknown'}`);
    if (session.resumedAt) lines.push(`Resumed: ${session.resumedAt}`);
  } else {
    lines.push('No active session');
  }
  const model = getUserModel(msg);
  lines.push(`Model: ${model || 'default'}`);
  lines.push(`Uptime: ${uptimeHr}h ${uptimeMin % 60}m`);
  return lines.join('\n');
}

/**
 * Wire up the bot's callback_query handler.
 *
 * @param {object} bot  node-telegram-bot-api instance
 * @param {number} startTime epoch ms when the bot started (for /info uptime)
 */
function registerCallbackHandlers(bot, startTime) {
  if (!INLINE_KEYBOARDS_ENABLED) {
    log.info('Inline keyboards disabled via INLINE_KEYBOARDS=false');
    return;
  }

  bot.on('callback_query', async (query) => {
    const data = query.data || '';
    const chatId = query.message?.chat?.id;
    const userId = query.from?.id;
    // Synthesize a minimal msg-shaped object so session-manager sees the
    // right key (DM vs group) — query.message is the bot's message, not
    // the user's, so we need to reconstruct `from` from query.from.
    const msg = {
      chat: query.message.chat,
      from: { id: userId },
    };

    try {
      if (data === CB.NEW) {
        clearSession(msg);
        await bot.answerCallbackQuery(query.id, { text: 'Session cleared' });
        await bot.sendMessage(chatId, 'Session cleared. Next message starts a fresh conversation.');
        log.info('callback /new', { chatId, userId });
        return;
      }

      if (data === CB.INFO) {
        const session = getSession(msg);
        const text = formatInfo(msg, session, startTime);
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        log.info('callback /info', { chatId, userId });
        return;
      }

      if (data === CB.SAVE) {
        const session = getSession(msg);
        if (!session?.sessionId) {
          await bot.answerCallbackQuery(query.id, { text: 'No active session', show_alert: true });
          return;
        }
        // Ask the user for a label, using ForceReply so their text input
        // is pre-focused at the prompt.
        const prompt = await bot.sendMessage(chatId,
          'What label should I save this session as?',
          { reply_markup: { force_reply: true, selective: true } }
        );
        savePromptIds.set(chatId, {
          messageId: prompt.message_id,
          expiresAt: Date.now() + SAVE_PROMPT_TTL_MS,
        });
        await bot.answerCallbackQuery(query.id);
        log.info('callback /save prompted', { chatId, userId, promptId: prompt.message_id });
        return;
      }

      // Unknown callback — just dismiss the spinner silently
      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      log.error('callback handler error', { error: err.message, data });
      try { await bot.answerCallbackQuery(query.id, { text: 'Error' }); } catch {}
    }
  });
}

/**
 * Check if an incoming message is a reply to an outstanding save prompt.
 * If so, label the session and return true (the main message handler
 * should then skip forwarding this text to Claude).
 */
async function handleSaveReplyIfPresent(bot, msg) {
  if (!INLINE_KEYBOARDS_ENABLED) return false;
  const chatId = msg.chat.id;
  const pending = savePromptIds.get(chatId);
  if (!pending) return false;

  // Expired?
  if (Date.now() > pending.expiresAt) {
    savePromptIds.delete(chatId);
    return false;
  }

  // Is this message actually a reply to our prompt?
  const replyToId = msg.reply_to_message?.message_id;
  if (replyToId !== pending.messageId) return false;

  savePromptIds.delete(chatId);

  const label = (msg.text || '').trim();
  if (!label) {
    await bot.sendMessage(chatId, 'Empty label — nothing saved. Try the 💾 button again.');
    return true;
  }

  const session = getSession(msg);
  if (!session?.sessionId) {
    await bot.sendMessage(chatId, 'No active session to label.');
    return true;
  }

  const ok = saveSessionLabel(msg, label);
  if (ok) {
    await bot.sendMessage(chatId,
      `Session labeled as <b>${label}</b>.\nResume later with: <code>/resume ${label}</code>`,
      { parse_mode: 'HTML' }
    );
    log.info('callback /save completed', { chatId, label });
  } else {
    await bot.sendMessage(chatId, 'Failed to save label.');
  }
  return true;
}

module.exports = {
  registerCallbackHandlers,
  buildResponseKeyboard,
  handleSaveReplyIfPresent,
  // Test helpers
  INLINE_KEYBOARDS_ENABLED,
  _savePromptIds: savePromptIds, // For tests to inspect state
};
