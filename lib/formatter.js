const MAX_LENGTH = 4000; // Telegram limit is 4096, leave margin

/**
 * Escape special characters for Telegram HTML parse mode.
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert Claude's Markdown output to Telegram-safe HTML.
 * Handles: bold, italic, inline code, code blocks, links.
 */
function markdownToTelegramHtml(text) {
  // First, extract code blocks to protect them from other transformations
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre>${escapeHtml(code.trimEnd())}</pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Escape HTML in non-code content
  processed = escapeHtml(processed);

  // Inline code (must come before bold/italic to avoid conflicts)
  processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  processed = processed.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words with underscores)
  processed = processed.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  processed = processed.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');

  // Links: [text](url)
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks
  processed = processed.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

  return processed;
}

/**
 * Chunk a message into Telegram-safe pieces (max 4000 chars each).
 * Tries to split at paragraph boundaries, then newlines, then hard-cut.
 */
function chunkMessage(text) {
  if (text.length <= MAX_LENGTH) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > MAX_LENGTH) {
    let splitAt = remaining.lastIndexOf('\n\n', MAX_LENGTH);
    if (splitAt < MAX_LENGTH * 0.3) {
      splitAt = remaining.lastIndexOf('\n', MAX_LENGTH);
    }
    if (splitAt < MAX_LENGTH * 0.3) {
      splitAt = MAX_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Format Claude's response for Telegram.
 * Returns array of HTML-formatted message chunks.
 */
function formatResponse(text) {
  const html = markdownToTelegramHtml(text);
  return chunkMessage(html);
}

module.exports = { formatResponse, escapeHtml };
