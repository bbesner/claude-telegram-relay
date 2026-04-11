// Tests for lib/session-exporter.js — the v1.4.0 /export Markdown renderer.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-exp-'));
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'error';

const {
  renderSessionMarkdown,
  renderAssistantContent,
  renderUserContent,
  renderToolUse,
  findSessionFile,
  readSession,
  exportSession,
} = require('../lib/session-exporter');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// ============================================================================
// renderUserContent
// ============================================================================

console.log('\n=== renderUserContent ===');

ok('string content returns as-is',
   renderUserContent('hello world') === 'hello world');

ok('array with text block',
   renderUserContent([{ type: 'text', text: 'hi there' }]) === 'hi there');

const mixed = renderUserContent([
  { type: 'text', text: 'before image' },
  { type: 'image', source: {} },
  { type: 'text', text: 'after image' },
]);
ok('array with image renders placeholder',
   mixed.includes('[image attached]') && mixed.includes('before image') && mixed.includes('after image'));

ok('document placeholder rendered',
   renderUserContent([{ type: 'document', source: {} }]).includes('[document attached]'));

ok('empty array returns empty string',
   renderUserContent([]) === '');

ok('unknown block type ignored',
   renderUserContent([{ type: 'unknown', foo: 'bar' }, { type: 'text', text: 'ok' }]) === 'ok');

// tool_result block
const toolResultRendered = renderUserContent([
  { type: 'tool_result', tool_use_id: 'x', content: 'result text here' },
]);
ok('tool_result renders as blockquoted code',
   toolResultRendered.includes('Tool result') && toolResultRendered.includes('result text here'));

// Long tool_result gets truncated
const longResult = renderUserContent([
  { type: 'tool_result', tool_use_id: 'x', content: 'x'.repeat(1000) },
]);
ok('long tool_result truncated',
   longResult.includes('[truncated]'));

// tool_result with array content (text blocks)
const arrayToolResult = renderUserContent([
  { type: 'tool_result', content: [{ type: 'text', text: 'from array' }] },
]);
ok('tool_result with array content handled',
   arrayToolResult.includes('from array'));

// ============================================================================
// renderToolUse
// ============================================================================

console.log('\n=== renderToolUse ===');

ok('Read tool renders file_path',
   renderToolUse({ name: 'Read', input: { file_path: '/etc/hosts' } }).includes('/etc/hosts'));

ok('Bash tool renders command',
   renderToolUse({ name: 'Bash', input: { command: 'ls -la' } }).includes('ls -la'));

ok('Grep tool renders pattern',
   renderToolUse({ name: 'Grep', input: { pattern: 'foo', path: '/bar' } }).includes('foo'));

ok('WebFetch renders url',
   renderToolUse({ name: 'WebFetch', input: { url: 'https://example.com' } }).includes('example.com'));

ok('Unknown tool falls back to compact JSON',
   renderToolUse({ name: 'CustomTool', input: { a: 1, b: 2 } }).includes('CustomTool'));

ok('Long primary field truncated',
   renderToolUse({ name: 'Read', input: { file_path: '/x'.repeat(200) } }).includes('…'));

ok('Tool with no input renders name',
   renderToolUse({ name: 'Foo', input: {} }).includes('Foo'));

// ============================================================================
// renderAssistantContent
// ============================================================================

console.log('\n=== renderAssistantContent ===');

ok('text block rendered',
   renderAssistantContent([{ type: 'text', text: 'hello' }]) === 'hello');

ok('multiple text blocks joined',
   renderAssistantContent([
     { type: 'text', text: 'first' },
     { type: 'text', text: 'second' },
   ]).includes('first') && renderAssistantContent([
     { type: 'text', text: 'first' },
     { type: 'text', text: 'second' },
   ]).includes('second'));

const withThinking = renderAssistantContent([
  { type: 'thinking', thinking: 'Let me think about this' },
  { type: 'text', text: 'Here is my answer' },
]);
ok('thinking block rendered as blockquote',
   withThinking.includes('Thinking') && withThinking.includes('Let me think'));
ok('thinking + text both present',
   withThinking.includes('Here is my answer'));

const withToolUse = renderAssistantContent([
  { type: 'text', text: 'Let me check.' },
  { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/foo' } },
  { type: 'text', text: 'Done.' },
]);
ok('tool_use between text blocks rendered',
   withToolUse.includes('/tmp/foo') && withToolUse.includes('Let me check') && withToolUse.includes('Done'));

ok('empty array returns empty',
   renderAssistantContent([]) === '');

ok('string content also handled (fallback)',
   renderAssistantContent('plain string') === 'plain string');

// ============================================================================
// renderSessionMarkdown
// ============================================================================

console.log('\n=== renderSessionMarkdown ===');

const fixtureEntries = [
  { type: 'queue-operation', operation: 'start' }, // should be skipped
  { type: 'user', timestamp: '2026-04-10T14:23:00Z', message: { content: 'Can you check the auth middleware?' } },
  { type: 'assistant', timestamp: '2026-04-10T14:23:05Z', message: { content: [
    { type: 'text', text: "I'll take a look." },
    { type: 'tool_use', name: 'Read', input: { file_path: 'lib/auth.js' } },
  ] } },
  { type: 'user', timestamp: '2026-04-10T14:23:06Z', message: { content: [
    { type: 'tool_result', tool_use_id: 'x', content: 'file content here' },
  ] } },
  { type: 'assistant', timestamp: '2026-04-10T14:23:10Z', message: { content: [
    { type: 'text', text: 'The issue is on line 42.' },
  ] } },
  { type: 'attachment', foo: 'bar' }, // should be skipped
];

const md = renderSessionMarkdown('a1b2c3d4-1111-2222-3333-444444444444', fixtureEntries);

ok('starts with # header',                   md.startsWith('# Claude Code Session'));
ok('contains session ID',                    md.includes('a1b2c3d4-1111-2222-3333-444444444444'));
ok('contains Started timestamp',             md.includes('Started'));
ok('user turn count correct',                md.includes('User turns:** 2'));
ok('assistant turn count correct',           md.includes('Assistant turns:** 2'));
ok('user emoji header',                      md.includes('🧑 User'));
ok('assistant emoji header',                 md.includes('🤖 Claude'));
ok('user prompt text rendered',              md.includes('Can you check the auth middleware?'));
ok('assistant text rendered',                md.includes("I'll take a look."));
ok('tool_use rendered with file path',       md.includes('lib/auth.js'));
ok('final assistant answer rendered',        md.includes('The issue is on line 42.'));
ok('queue-operation entry skipped',          !md.includes('queue-operation'));
ok('attachment entry skipped',               !md.includes('"foo":"bar"'));

// User message that's ONLY a tool_result (echo from a tool call) should be skipped
// because the assistant entry that triggered it already rendered the tool_use.
const onlyToolResultEntries = [
  { type: 'user', timestamp: '2026-04-10T14:00:00Z', message: { content: 'real prompt' } },
  { type: 'assistant', timestamp: '2026-04-10T14:00:01Z', message: { content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
  ] } },
  { type: 'user', timestamp: '2026-04-10T14:00:02Z', message: { content: [
    { type: 'tool_result', content: 'file1\nfile2' },
  ] } },
];
const mdNoToolEcho = renderSessionMarkdown('test', onlyToolResultEntries);
// The tool_result echo user entry should NOT produce a 🧑 User header between
// the two content entries — we should only have ONE User header
const userHeaderCount = (mdNoToolEcho.match(/🧑 User/g) || []).length;
ok('tool_result-only user entries skipped', userHeaderCount === 1,
   `got ${userHeaderCount} user headers`);

// ============================================================================
// findSessionFile + readSession
// ============================================================================

console.log('\n=== findSessionFile + readSession ===');

// Build a fake projects tree
const projectsDir = path.join(SCRATCH, '.claude', 'projects');
const bucket = path.join(projectsDir, '-tmp-demo');
fs.mkdirSync(bucket, { recursive: true });
const testSid = 'ffffffff-1111-2222-3333-444444444444';
const testJsonl = path.join(bucket, testSid + '.jsonl');
fs.writeFileSync(testJsonl,
  JSON.stringify({ type: 'user', timestamp: '2026-04-10T12:00:00Z', message: { content: 'hi' } }) + '\n' +
  JSON.stringify({ type: 'assistant', timestamp: '2026-04-10T12:00:05Z', message: { content: [{ type: 'text', text: 'hello' }] } }) + '\n' +
  'not a valid json line\n' +
  JSON.stringify({ type: 'user', timestamp: '2026-04-10T12:00:10Z', message: { content: 'bye' } }) + '\n'
);

ok('findSessionFile returns path when present', findSessionFile(testSid) === testJsonl);
ok('findSessionFile returns null when absent',  findSessionFile('deadbeef-1111-2222-3333-444444444444') === null);

const parsed = readSession(testJsonl);
ok('readSession skipped malformed line and returned rest', parsed.length === 3);

// ============================================================================
// exportSession — full round trip
// ============================================================================

console.log('\n=== exportSession full round trip ===');

(async () => {
  const { path: outPath, size } = await exportSession(testSid);
  ok('export wrote a file',       fs.existsSync(outPath));
  ok('export returned a size',    size > 0);
  const contents = fs.readFileSync(outPath, 'utf8');
  ok('export contains header',     contents.includes('# Claude Code Session'));
  ok('export contains user prompt', contents.includes('hi'));
  ok('export contains assistant',   contents.includes('hello'));
  ok('export filename uses first 8 chars of session id',
     path.basename(outPath).startsWith('session-ffffffff'));

  // Missing session → throws
  try {
    await exportSession('00000000-1111-2222-3333-444444444444');
    ok('missing session throws', false);
  } catch (e) {
    ok('missing session throws', e.message.includes('not found'));
  }

  // Empty session file → throws
  const emptySid = 'eeeeeeee-1111-2222-3333-444444444444';
  fs.writeFileSync(path.join(bucket, emptySid + '.jsonl'), '');
  try {
    await exportSession(emptySid);
    ok('empty session throws', false);
  } catch (e) {
    ok('empty session throws', e.message.includes('empty') || e.message.includes('unreadable'));
  }

  // Cleanup
  try { fs.unlinkSync(outPath); } catch {}
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\nsession-exporter: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
