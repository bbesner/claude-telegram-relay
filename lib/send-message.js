// ============================================================================
// lib/send-message.js — Outbound Telegram message helper (Node.js module)
// Part of claude-telegram-relay v1.3.0+
//
// Send messages through your Telegram bot to allowed users.
//
// Usage:
//   const { sendMessage } = require('./lib/send-message');
//   await sendMessage('Hello from Node');
//   await sendMessage('Custom recipient', { chatId: 123456789 });
//   await sendMessage('Long body...', { title: 'Deploy done' });
//   await sendMessage('*bold*', { parseMode: 'Markdown' });
//
// Environment variables (loaded from .env if dotenv is configured upstream):
//   TELEGRAM_BOT_TOKEN  Bot token (required)
//   DEFAULT_CHAT_ID     Default chat ID (overrides ALLOWED_USER_IDS first entry)
//   ALLOWED_USER_IDS    Comma-separated user IDs (first one used as default)
// ============================================================================

const https = require('https');

const TELEGRAM_API_HOST = 'api.telegram.org';
const MAX_MESSAGE_LENGTH = 3800; // Leave room for chunk markers under Telegram's 4096 hard limit

/**
 * Resolve the default chat ID from environment variables.
 * @returns {number|null} Numeric chat ID, or null if none configured
 */
function getDefaultChatId() {
  if (process.env.DEFAULT_CHAT_ID) {
    const id = parseInt(process.env.DEFAULT_CHAT_ID, 10);
    if (!Number.isNaN(id)) return id;
  }
  if (process.env.ALLOWED_USER_IDS) {
    const first = process.env.ALLOWED_USER_IDS.split(',')[0].trim();
    const id = parseInt(first, 10);
    if (!Number.isNaN(id)) return id;
  }
  return null;
}

/**
 * Split a long message into chunks that fit within Telegram's per-message limit.
 * Prefers breaking at paragraph boundaries, falls back to line and word breaks.
 *
 * @param {string} text   Source text to chunk
 * @param {number} maxLen Max length per chunk (default 3800)
 * @returns {string[]}    Array of chunks
 */
function chunkMessage(text, maxLen = MAX_MESSAGE_LENGTH) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitAt === -1) {
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Send a single Telegram message via the bot API.
 * Returns the message_id on success, throws on failure.
 *
 * @param {string} token    Bot token
 * @param {number} chatId   Target chat ID
 * @param {string} text     Message body (already chunked)
 * @param {string} [parseMode] Optional parse mode (Markdown / MarkdownV2 / HTML)
 * @returns {Promise<number>} Telegram message_id
 */
function sendOne(token, chatId, text, parseMode) {
  return new Promise((resolve, reject) => {
    const payload = { chat_id: chatId, text };
    if (parseMode) payload.parse_mode = parseMode;

    const body = JSON.stringify(payload);
    const req = https.request(
      {
        host: TELEGRAM_API_HOST,
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (!result.ok) {
              reject(
                new Error(
                  `Telegram API rejected message (code ${res.statusCode}): ${result.description || data}`
                )
              );
              return;
            }
            resolve(result.result.message_id);
          } catch (e) {
            reject(new Error(`Failed to parse Telegram API response: ${e.message}`));
          }
        });
      }
    );

    req.on('error', (e) => reject(new Error(`Telegram request failed: ${e.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram request timed out after 15s'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Send a message to your Telegram bot.
 *
 * Long messages (over ~3800 chars) are automatically split at paragraph
 * boundaries and sent as multiple sequential messages.
 *
 * @param {string} text                Message body
 * @param {object} [options]
 * @param {number} [options.chatId]    Override the default chat ID
 * @param {string} [options.title]     Optional title prepended to the body
 * @param {string} [options.parseMode] Telegram parse mode (Markdown, MarkdownV2, HTML)
 * @param {string} [options.token]     Override the bot token (default: env)
 * @returns {Promise<number[]>}        Array of message_ids that were sent
 */
async function sendMessage(text, options = {}) {
  const token = options.token || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN not set (pass options.token or set env var)');
  }

  const chatId = options.chatId || getDefaultChatId();
  if (chatId == null) {
    throw new Error(
      'No chat ID available. Pass options.chatId, or set DEFAULT_CHAT_ID / ALLOWED_USER_IDS'
    );
  }

  if (!text || typeof text !== 'string') {
    throw new Error('Message text is required and must be a string');
  }

  let body = text;
  if (options.title) {
    body = `${options.title}\n\n${text}`;
  }

  const parts = chunkMessage(body);
  const ids = [];
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `[${i + 1}/${parts.length}] ` : '';
    const id = await sendOne(token, chatId, prefix + parts[i], options.parseMode);
    ids.push(id);
  }
  return ids;
}

module.exports = {
  sendMessage,
  chunkMessage, // exported for testing
  getDefaultChatId, // exported for testing
};
