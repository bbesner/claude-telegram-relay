const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const log = require('./logger');

const TEMP_DIR = path.join(process.env.HOME || '/tmp', '.claude-telegram-relay', 'media');

// Ensure temp dir exists
fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Download a file from a URL to a local temp path.
 * @param {string} url
 * @param {string} filename
 * @returns {Promise<string>} Local file path
 */
function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    const filePath = path.join(TEMP_DIR, `${Date.now()}-${filename}`);
    const file = fs.createWriteStream(filePath);
    const client = url.startsWith('https') ? https : http;

    client.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Follow redirect
        downloadFile(response.headers.location, filename).then(resolve).catch(reject);
        file.close();
        fs.unlinkSync(filePath);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(filePath);
      });
    }).on('error', (err) => {
      fs.unlink(filePath, () => {});
      reject(err);
    });
  });
}

/**
 * Download a Telegram file by file_id.
 * @param {TelegramBot} bot
 * @param {string} fileId
 * @param {string} [fallbackName]
 * @returns {Promise<string>} Local file path
 */
async function downloadTelegramFile(bot, fileId, fallbackName = 'file') {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const filename = path.basename(file.file_path || fallbackName);
  const localPath = await downloadFile(url, filename);
  log.debug('File downloaded', { fileId, localPath, size: fs.statSync(localPath).size });
  return localPath;
}

/**
 * Extract file info from a Telegram message.
 * Returns { fileId, fileName, type } or null if no media.
 */
function extractMediaInfo(msg) {
  // Photo — get the largest resolution
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    return { fileId: largest.file_id, fileName: 'photo.jpg', type: 'photo' };
  }

  // Document (PDF, files, etc.)
  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      fileName: msg.document.file_name || 'document',
      type: 'document',
    };
  }

  // Voice message
  if (msg.voice) {
    return { fileId: msg.voice.file_id, fileName: 'voice.ogg', type: 'voice' };
  }

  // Video
  if (msg.video) {
    return {
      fileId: msg.video.file_id,
      fileName: msg.video.file_name || 'video.mp4',
      type: 'video',
    };
  }

  // Sticker
  if (msg.sticker) {
    return { fileId: msg.sticker.file_id, fileName: 'sticker.webp', type: 'sticker' };
  }

  return null;
}

/**
 * Build a prompt that includes a file reference for Claude to read.
 * @param {string} localPath - Path to the downloaded file
 * @param {string} type - Media type (photo, document, etc.)
 * @param {string} [caption] - User's caption/message
 * @returns {string} Prompt for Claude
 */
function buildMediaPrompt(localPath, type, caption) {
  const fileDesc = {
    photo: 'image/screenshot',
    document: 'document/file',
    voice: 'voice message audio file',
    video: 'video file',
    sticker: 'sticker image',
  }[type] || 'file';

  let prompt = `The user sent a ${fileDesc}. It has been saved to: ${localPath}\n`;
  prompt += `Please read/view this file using your Read tool and respond to it.`;

  if (caption) {
    prompt += `\n\nThe user's message with this file: "${caption}"`;
  } else {
    prompt += `\n\nNo caption was provided. Describe or analyze the file as appropriate.`;
  }

  return prompt;
}

/**
 * Extract file paths from Claude's response that look like created/written files.
 * Looks for patterns like "File created at /path" or "Written to /path".
 * @param {string} text - Claude's response text
 * @returns {string[]} Array of file paths
 */
function extractCreatedFiles(text) {
  if (!text) return [];

  const patterns = [
    /(?:created|written|saved|generated|exported|output)\s+(?:successfully\s+)?(?:at|to|in|as)\s+[`"]?([/~][^\s`"<>,]+)/gi,
    /(?:file|image|pdf|document|output):\s*[`"]?([/~][^\s`"<>,]+)/gi,
    /`(\/[^\s`]+\.\w{2,5})`/g, // backtick-wrapped absolute paths with extensions
  ];

  const files = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      let filePath = match[1];
      if (filePath.startsWith('~')) {
        filePath = filePath.replace('~', process.env.HOME || '/tmp');
      }
      // Only include files that actually exist
      if (fs.existsSync(filePath)) {
        files.add(filePath);
      }
    }
  }
  return [...files];
}

/**
 * Clean up old temp files (older than 1 hour).
 */
function cleanupTempFiles() {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        log.debug('Cleaned up temp file', { file });
      }
    }
  } catch (e) {
    log.warn('Temp cleanup failed', { error: e.message });
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupTempFiles, 30 * 60 * 1000);

module.exports = {
  downloadTelegramFile,
  extractMediaInfo,
  buildMediaPrompt,
  extractCreatedFiles,
};
