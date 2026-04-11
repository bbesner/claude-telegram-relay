// Tests for lib/openclaw-memory.js — the v1.4.0 /memory passthrough.
// Mocks child_process.spawn so nothing actually executes openclaw.

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const EventEmitter = require('events');

// ---- Mock child_process.spawn BEFORE requiring the module ----
let mockSpawnBehavior = null;
let capturedSpawnCalls = [];

const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'child_process') {
    return {
      spawn(binary, args, opts) {
        capturedSpawnCalls.push({ binary, args, opts });

        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => { child.killed = true; };
        child.killed = false;

        const b = mockSpawnBehavior || { code: 0, stdout: '{"results":[]}' };
        setImmediate(() => {
          if (b.stdout) child.stdout.emit('data', Buffer.from(b.stdout));
          if (b.stderr) child.stderr.emit('data', Buffer.from(b.stderr));
          if (b.spawnError) {
            child.emit('error', new Error(b.spawnError));
          } else {
            child.emit('close', b.code);
          }
        });

        return child;
      },
    };
  }
  return origLoad.apply(this, [request, parent, ...rest]);
};

const { detectOpenclaw, searchMemory, formatMemoryResults } = require('../lib/openclaw-memory');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// Fresh scratch HOME so default-path detection is deterministic
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-oc-'));
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'error'; // silence info logs

function reset() {
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_BIN;
  delete process.env.OPENCLAW_CWD;
  mockSpawnBehavior = null;
  capturedSpawnCalls = [];
}

// ============================================================================
// detectOpenclaw
// ============================================================================

console.log('\n=== detectOpenclaw ===');

reset();
// No config anywhere → null
ok('no config → null', detectOpenclaw() === null);

// Default location
reset();
const defaultDir = path.join(SCRATCH, '.openclaw');
fs.mkdirSync(defaultDir, { recursive: true });
const defaultCfg = path.join(defaultDir, 'openclaw.json');
fs.writeFileSync(defaultCfg, '{}');
const d1 = detectOpenclaw();
ok('default location detected', d1 !== null);
ok('default configPath correct', d1?.configPath === defaultCfg);
ok('default cwd = config dir',   d1?.cwd === defaultDir);
ok('default binary = openclaw',  d1?.binary === 'openclaw');

// Explicit override via env var
reset();
const customCfg = path.join(SCRATCH, 'custom-openclaw.json');
fs.writeFileSync(customCfg, '{}');
process.env.OPENCLAW_CONFIG_PATH = customCfg;
const d2 = detectOpenclaw();
ok('OPENCLAW_CONFIG_PATH override detected',     d2 !== null);
ok('override configPath matches env var',         d2?.configPath === customCfg);
ok('override cwd defaults to config parent dir',  d2?.cwd === SCRATCH);

// Override with custom binary + cwd
reset();
process.env.OPENCLAW_CONFIG_PATH = customCfg;
process.env.OPENCLAW_BIN = '/opt/custom/openclaw';
process.env.OPENCLAW_CWD = '/some/other/dir';
const d3 = detectOpenclaw();
ok('OPENCLAW_BIN honored',  d3?.binary === '/opt/custom/openclaw');
ok('OPENCLAW_CWD honored',  d3?.cwd === '/some/other/dir');

// Nonexistent path in env var → falls through to default
reset();
process.env.OPENCLAW_CONFIG_PATH = '/totally/missing/config.json';
const d4 = detectOpenclaw();
ok('missing OPENCLAW_CONFIG_PATH falls through to default',
   d4?.configPath === defaultCfg);

// Remove the default config and confirm it's null again
reset();
fs.rmSync(defaultCfg);
process.env.OPENCLAW_CONFIG_PATH = '/missing';
ok('missing default AND missing override → null', detectOpenclaw() === null);

// ============================================================================
// searchMemory — happy path
// ============================================================================

console.log('\n=== searchMemory happy path ===');

(async () => {
  const detected = {
    configPath: '/home/user/.openclaw/openclaw.json',
    cwd: '/home/user/.openclaw',
    binary: 'openclaw',
  };

  // Happy path with results
  mockSpawnBehavior = {
    code: 0,
    stdout: JSON.stringify({
      results: [
        { path: 'memory/2026-04-10.md', startLine: 100, endLine: 105, score: 0.82, snippet: 'First result', source: 'memory' },
        { path: 'memory/2026-04-11.md', startLine: 200, endLine: 210, score: 0.65, snippet: 'Second result', source: 'memory' },
      ],
    }),
  };
  const r1 = await searchMemory('test query', detected);
  ok('happy path returns 2 results', r1.results.length === 2);
  ok('result score preserved',       r1.results[0].score === 0.82);
  ok('result snippet preserved',     r1.results[0].snippet === 'First result');

  // Verify argv was constructed correctly (no shell interpolation)
  const call = capturedSpawnCalls[0];
  ok('spawn called with openclaw binary',  call.binary === 'openclaw');
  ok('args includes memory search',        call.args.includes('memory') && call.args.includes('search'));
  ok('args includes --json',               call.args.includes('--json'));
  ok('query passed as its own argv entry', call.args.includes('test query'));
  ok('--max-results default to 5',         call.args.includes('--max-results') && call.args[call.args.indexOf('--max-results') + 1] === '5');
  ok('cwd passed to spawn',                call.opts.cwd === '/home/user/.openclaw');
  ok('OPENCLAW_CONFIG_PATH injected into env',
     call.opts.env.OPENCLAW_CONFIG_PATH === '/home/user/.openclaw/openclaw.json');

  // Custom maxResults
  mockSpawnBehavior = { code: 0, stdout: '{"results":[]}' };
  capturedSpawnCalls = [];
  await searchMemory('q', detected, { maxResults: 10 });
  ok('maxResults override honored',
     capturedSpawnCalls[0].args[capturedSpawnCalls[0].args.indexOf('--max-results') + 1] === '10');

  // Shell injection attempt — query is passed as argv, should not execute
  mockSpawnBehavior = { code: 0, stdout: '{"results":[]}' };
  capturedSpawnCalls = [];
  await searchMemory('; rm -rf /', detected);
  ok('injection query passed verbatim in argv',
     capturedSpawnCalls[0].args.includes('; rm -rf /'));

  // "No matches." plain-text response (older openclaw versions)
  mockSpawnBehavior = { code: 0, stdout: 'No matches.' };
  const r2 = await searchMemory('q', detected);
  ok('"No matches." plain text handled', r2.results.length === 0);

  // Empty stdout
  mockSpawnBehavior = { code: 0, stdout: '' };
  const r3 = await searchMemory('q', detected);
  ok('empty stdout handled', r3.results.length === 0);

  // Bare array shape (future-proof fallback)
  mockSpawnBehavior = { code: 0, stdout: '[{"path":"a","snippet":"s","score":0.5}]' };
  const r4 = await searchMemory('q', detected);
  ok('bare array shape also accepted', r4.results.length === 1);

  // ==========================================================================
  // searchMemory — error paths
  // ==========================================================================

  console.log('\n=== searchMemory error paths ===');

  // Nonzero exit code
  mockSpawnBehavior = { code: 1, stderr: 'some error message' };
  try {
    await searchMemory('q', detected);
    ok('nonzero exit rejects', false);
  } catch (e) {
    ok('nonzero exit rejects', e.message.includes('some error message'));
  }

  // Unparseable JSON
  mockSpawnBehavior = { code: 0, stdout: 'not-json' };
  try {
    await searchMemory('q', detected);
    ok('unparseable JSON rejects', false);
  } catch (e) {
    ok('unparseable JSON rejects', e.message.includes('parse'));
  }

  // Spawn error (e.g. binary not found)
  mockSpawnBehavior = { spawnError: 'ENOENT' };
  try {
    await searchMemory('q', detected);
    ok('spawn error rejects', false);
  } catch (e) {
    ok('spawn error rejects', e.message.includes('ENOENT'));
  }

  // ==========================================================================
  // formatMemoryResults
  // ==========================================================================

  console.log('\n=== formatMemoryResults ===');

  ok('no results → "No memory matches"',
     formatMemoryResults('foo', []).includes('No memory matches'));

  const html = formatMemoryResults('twilio fix', [
    { path: 'memory/2026-04-10.md', startLine: 42, endLine: 50, score: 0.8249, snippet: 'Found it at 3AM' },
  ]);
  ok('result number rendered',            html.includes('1.'));
  ok('path:startLine-endLine rendered',   html.includes('memory/2026-04-10.md:42-50'));
  ok('score rounded to 2 decimals',       html.includes('0.82'));
  ok('snippet rendered',                  html.includes('Found it at 3AM'));
  ok('query rendered in header',          html.includes('twilio fix'));

  // HTML-escape user input in query and paths
  const xssHtml = formatMemoryResults('<script>', [
    { path: '<evil>.md', snippet: '<img src=x>', score: 0.5 },
  ]);
  ok('query escaped',   xssHtml.includes('&lt;script&gt;'));
  ok('path escaped',    xssHtml.includes('&lt;evil&gt;.md'));
  ok('snippet escaped', xssHtml.includes('&lt;img src=x&gt;'));

  // Long snippet truncated
  const longSnippet = 'x'.repeat(500);
  const longHtml = formatMemoryResults('q', [
    { path: 'a', snippet: longSnippet, score: 0.5 },
  ]);
  ok('long snippet truncated with ellipsis',
     longHtml.includes('…') && !longHtml.includes('x'.repeat(500)));

  // Cleanup
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\nopenclaw-memory: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
