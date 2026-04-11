// Test runner: executes each suite in its own child process so module caches
// and env vars don't bleed between suites. Aggregates pass/fail counts and
// exits nonzero if any suite failed.
const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  'test-session-browser.js',
  'test-session-manager.js',
  'test-commands.js',
  'test-bot-smoke.js',
  'test-formatter.js',
  'test-send-message.js',
  'test-openclaw-memory.js',
  'test-memory-command.js',
  'test-callbacks.js',
  'test-session-exporter.js',
  'test-export-command.js',
];

const t0 = Date.now();
const results = [];

for (const suite of suites) {
  const suitePath = path.join(__dirname, suite);
  console.log(`\n${'='.repeat(60)}\n  ${suite}\n${'='.repeat(60)}`);
  const r = spawnSync('node', [suitePath], { stdio: 'inherit' });
  results.push({ suite, code: r.status });
}

const elapsed = Date.now() - t0;
const passed = results.filter(r => r.code === 0).length;
const failed = results.filter(r => r.code !== 0).length;

console.log(`\n${'='.repeat(60)}`);
console.log(`  Summary: ${passed}/${results.length} suites passed in ${elapsed}ms`);
console.log('='.repeat(60));
for (const r of results) {
  console.log(`  ${r.code === 0 ? 'ok  ' : 'FAIL'}  ${r.suite}`);
}

process.exit(failed === 0 ? 0 : 1);
