// Tests for lib/formatter.js — covers the Markdown → Telegram HTML conversion,
// the new syntax-highlighted code blocks from v1.4.0, and message chunking.
const { formatResponse, markdownToTelegramHtml, chunkMessage, escapeHtml, normalizeLanguage, TELEGRAM_HIGHLIGHT_LANGUAGES } = require('../lib/formatter');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// ---------- escapeHtml ----------
ok('escapeHtml < > &',        escapeHtml('<b>&</b>') === '&lt;b&gt;&amp;&lt;/b&gt;');
ok('escapeHtml empty string', escapeHtml('') === '');
ok('escapeHtml no specials',  escapeHtml('hello world') === 'hello world');
ok('escapeHtml ampersand first',
   escapeHtml('&<>') === '&amp;&lt;&gt;'); // ensure & is escaped before < and >

// ---------- normalizeLanguage ----------
ok('normalizeLanguage python',  normalizeLanguage('python')     === 'python');
ok('normalizeLanguage py alias', normalizeLanguage('py')        === 'python');
ok('normalizeLanguage JS alias', normalizeLanguage('js')        === 'javascript');
ok('normalizeLanguage uppercase', normalizeLanguage('PYTHON')   === 'python');
ok('normalizeLanguage sh→bash',  normalizeLanguage('sh')        === 'bash');
ok('normalizeLanguage empty',    normalizeLanguage('')          === null);
ok('normalizeLanguage unsupported', normalizeLanguage('brainfuck') === null);
ok('normalizeLanguage whitespace stays null', normalizeLanguage(' ') === null);

// ---------- markdownToTelegramHtml: basic inline ----------
ok('bold **foo**',
   markdownToTelegramHtml('**foo**') === '<b>foo</b>');
ok('bold __foo__',
   markdownToTelegramHtml('__foo__') === '<b>foo</b>');
ok('italic *foo*',
   markdownToTelegramHtml('hello *foo* bar') === 'hello <i>foo</i> bar');
ok('inline code',
   markdownToTelegramHtml('call `fn()` please') === 'call <code>fn()</code> please');
ok('link',
   markdownToTelegramHtml('see [docs](https://example.com)') === 'see <a href="https://example.com">docs</a>');

// ---------- markdownToTelegramHtml: HTML escaping in prose ----------
ok('raw < is escaped outside code blocks',
   markdownToTelegramHtml('use <script>') === 'use &lt;script&gt;');
ok('ampersand in prose escaped',
   markdownToTelegramHtml('a & b') === 'a &amp; b');

// ---------- markdownToTelegramHtml: code blocks ----------
const plainBlock = markdownToTelegramHtml('```\nhello\n```');
ok('plain code block uses <pre>',
   plainBlock === '<pre>hello</pre>',
   `got: ${plainBlock}`);

const pythonBlock = markdownToTelegramHtml('```python\ndef f():\n  return 1\n```');
ok('python code block uses <pre><code class="language-python">',
   pythonBlock === '<pre><code class="language-python">def f():\n  return 1</code></pre>',
   `got: ${pythonBlock}`);

const jsAliasBlock = markdownToTelegramHtml('```js\nconst x = 1;\n```');
ok('js alias normalized to javascript',
   jsAliasBlock.includes('class="language-javascript"'),
   `got: ${jsAliasBlock}`);

const unsupportedBlock = markdownToTelegramHtml('```brainfuck\n++>\n```');
ok('unsupported language falls back to <pre>',
   unsupportedBlock === '<pre>++&gt;</pre>',
   `got: ${unsupportedBlock}`);

// ---------- code blocks must escape their content ----------
const xssBlock = markdownToTelegramHtml('```js\n<script>alert(1)</script>\n```');
ok('<script> inside js code block is escaped',
   xssBlock.includes('&lt;script&gt;') && !xssBlock.includes('<script>alert'),
   `got: ${xssBlock}`);

// ---------- code block content is NOT italicized/bolded/etc ----------
const preservedMarkers = markdownToTelegramHtml('```py\na = **not_bold** and *not_italic*\n```');
ok('markdown metacharacters inside code block are preserved',
   preservedMarkers.includes('**not_bold**') && preservedMarkers.includes('*not_italic*'),
   `got: ${preservedMarkers}`);

// ---------- multiple code blocks in one message ----------
const multi = markdownToTelegramHtml('First:\n```py\na\n```\nThen:\n```js\nb\n```');
ok('multiple code blocks both rendered',
   multi.includes('class="language-python"') && multi.includes('class="language-javascript"'),
   `got: ${multi}`);
ok('prose between code blocks preserved',
   multi.includes('First:') && multi.includes('Then:'));

// ---------- prose around code blocks still gets markdown conversion ----------
const mixed = markdownToTelegramHtml('**Important:** run\n```bash\nnpm test\n```\nand verify.');
ok('bold in surrounding prose applied',  mixed.includes('<b>Important:</b>'));
ok('bash code block highlighted',        mixed.includes('class="language-bash"'));
ok('post-block prose preserved',          mixed.includes('and verify.'));

// ---------- chunkMessage ----------
ok('short text returns 1 chunk',
   chunkMessage('hello world').length === 1);

const longLine = 'x'.repeat(4500);
const chunks = chunkMessage(longLine);
ok('long text is chunked',  chunks.length >= 2);
ok('each chunk within limit', chunks.every(c => c.length <= 4000));

// Text with paragraph boundaries chunks at them
const para = 'a'.repeat(2000) + '\n\n' + 'b'.repeat(2500);
const paraChunks = chunkMessage(para);
ok('paragraph-boundary chunking', paraChunks.length === 2 && paraChunks[0].length <= 4000);

// ---------- formatResponse (integration) ----------
const full = formatResponse('Here is the fix:\n\n```python\ndef hello():\n    return "world"\n```\n\nDone.');
ok('formatResponse returns array', Array.isArray(full));
ok('formatResponse contains language-python', full[0].includes('class="language-python"'));
ok('formatResponse preserves surrounding text',
   full[0].includes('Here is the fix:') && full[0].includes('Done.'));

// ---------- edge cases ----------
ok('empty string returns one empty chunk',
   formatResponse('').length === 1 && formatResponse('')[0] === '');

const backtickInProse = markdownToTelegramHtml('Use `npm test` to run.');
ok('inline code in prose',
   backtickInProse === 'Use <code>npm test</code> to run.');

const ampInCode = markdownToTelegramHtml('```\na && b\n```');
ok('ampersand inside code block escaped',
   ampInCode.includes('a &amp;&amp; b'));

// ---------- language whitelist sanity ----------
ok('TELEGRAM_HIGHLIGHT_LANGUAGES is a Set', TELEGRAM_HIGHLIGHT_LANGUAGES instanceof Set);
ok('whitelist includes python',      TELEGRAM_HIGHLIGHT_LANGUAGES.has('python'));
ok('whitelist includes typescript',  TELEGRAM_HIGHLIGHT_LANGUAGES.has('typescript'));
ok('whitelist includes bash',        TELEGRAM_HIGHLIGHT_LANGUAGES.has('bash'));
ok('whitelist does NOT include brainfuck', !TELEGRAM_HIGHLIGHT_LANGUAGES.has('brainfuck'));

console.log(`\nformatter: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
