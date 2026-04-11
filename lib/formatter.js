const MAX_LENGTH = 4000; // Telegram limit is 4096, leave margin

// Languages Telegram's clients can syntax-highlight. Emitting a class="language-X"
// outside this set wastes bytes — Telegram falls back to plain <pre><code> anyway,
// but some language aliases can confuse downstream clients, so keep the list tight.
// Aliases (e.g. js → javascript) are normalized before lookup.
const TELEGRAM_HIGHLIGHT_LANGUAGES = new Set([
  'bash', 'sh', 'shell', 'zsh',
  'c', 'cpp', 'csharp', 'cs',
  'css', 'scss', 'less',
  'diff',
  'dockerfile',
  'go',
  'graphql',
  'html', 'xml',
  'ini', 'toml',
  'java', 'kotlin',
  'javascript', 'js', 'jsx',
  'json', 'json5',
  'lua',
  'makefile',
  'markdown', 'md',
  'objectivec',
  'perl',
  'php',
  'powershell', 'ps1',
  'python', 'py',
  'r',
  'ruby', 'rb',
  'rust', 'rs',
  'scala',
  'sql',
  'swift',
  'typescript', 'ts', 'tsx',
  'yaml', 'yml',
]);

// Map aliases to canonical language names used in Telegram's rendering.
const LANGUAGE_ALIASES = {
  sh: 'bash', shell: 'bash', zsh: 'bash',
  cs: 'csharp',
  js: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  ps1: 'powershell',
  md: 'markdown',
  yml: 'yaml',
  json5: 'json',
  xml: 'html',
};

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
 * Resolve a user-specified language hint to a canonical Telegram-supported
 * language name, or null if unsupported.
 */
function normalizeLanguage(lang) {
  if (!lang) return null;
  const lower = lang.toLowerCase();
  if (!TELEGRAM_HIGHLIGHT_LANGUAGES.has(lower)) return null;
  return LANGUAGE_ALIASES[lower] || lower;
}

/**
 * Convert Claude's Markdown output to Telegram-safe HTML.
 * Handles: bold, italic, inline code, code blocks (with language-aware
 * syntax highlighting when a hint is supplied), and links.
 */
function markdownToTelegramHtml(text) {
  // First, extract code blocks to protect them from other transformations.
  // When a language hint is present and supported by Telegram's highlighter,
  // emit <pre><code class="language-X"> so clients can color the body.
  // Otherwise fall back to a plain <pre> block.
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const canonical = normalizeLanguage(lang);
    const escaped = escapeHtml(code.trimEnd());
    const html = canonical
      ? `<pre><code class="language-${canonical}">${escaped}</code></pre>`
      : `<pre>${escaped}</pre>`;
    codeBlocks.push(html);
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

module.exports = {
  formatResponse,
  markdownToTelegramHtml,
  chunkMessage,
  escapeHtml,
  normalizeLanguage,
  TELEGRAM_HIGHLIGHT_LANGUAGES,
};
