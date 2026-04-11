// Tests for lib/update-checker.js — v1.5.0 release notifier.
// All network calls are injected via deps.fetcher so nothing hits GitHub.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Use a scratch HOME so the persistent state file doesn't clobber the real one
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-uc-'));
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'error';
delete process.env.UPDATE_CHECK;

const uc = require('../lib/update-checker');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// Reset scratch state between tests
function clearState() {
  try { fs.rmSync(uc.STATE_FILE, { force: true }); } catch {}
  try { fs.rmSync(uc.STATE_FILE + '.tmp', { force: true }); } catch {}
}

// ============================================================================
// parseVersion
// ============================================================================

console.log('\n=== parseVersion ===');

ok('parseVersion v1.2.3',        JSON.stringify(uc.parseVersion('v1.2.3')) === '[1,2,3]');
ok('parseVersion 1.2.3',         JSON.stringify(uc.parseVersion('1.2.3'))  === '[1,2,3]');
ok('parseVersion uppercase V',   JSON.stringify(uc.parseVersion('V2.0.0')) === '[2,0,0]');
ok('parseVersion short 1.2',     JSON.stringify(uc.parseVersion('1.2'))    === '[1,2,0]');
ok('parseVersion bare 5',        JSON.stringify(uc.parseVersion('5'))      === '[5,0,0]');
ok('parseVersion pre-release strips',
   JSON.stringify(uc.parseVersion('1.2.3-beta.1')) === '[1,2,3]');
ok('parseVersion build metadata strips',
   JSON.stringify(uc.parseVersion('1.2.3+build.42')) === '[1,2,3]');
ok('parseVersion invalid returns null', uc.parseVersion('garbage') === null);
ok('parseVersion empty returns null',    uc.parseVersion('') === null);
ok('parseVersion non-string returns null', uc.parseVersion(42) === null);

// ============================================================================
// isNewer
// ============================================================================

console.log('\n=== isNewer ===');

ok('1.5.0 newer than 1.4.0',   uc.isNewer('1.5.0', '1.4.0') === true);
ok('1.4.1 newer than 1.4.0',   uc.isNewer('1.4.1', '1.4.0') === true);
ok('2.0.0 newer than 1.9.9',   uc.isNewer('2.0.0', '1.9.9') === true);
ok('1.4.0 NOT newer than 1.4.0', uc.isNewer('1.4.0', '1.4.0') === false);
ok('1.3.9 NOT newer than 1.4.0', uc.isNewer('1.3.9', '1.4.0') === false);
ok('v-prefix handled on both sides', uc.isNewer('v1.5.0', 'v1.4.0') === true);
ok('invalid remote returns false',  uc.isNewer('garbage', '1.0.0') === false);
ok('invalid local returns false',   uc.isNewer('1.0.0', 'garbage') === false);

// ============================================================================
// State persistence
// ============================================================================

console.log('\n=== loadState / saveState ===');

clearState();
ok('loadState on missing file returns defaults',
   JSON.stringify(uc.loadState()) === '{"lastNotifiedVersion":null,"lastCheckedAt":null}');

uc.saveState({ lastNotifiedVersion: 'v1.5.0', lastCheckedAt: 123456 });
const loaded = uc.loadState();
ok('saveState round-trips lastNotifiedVersion', loaded.lastNotifiedVersion === 'v1.5.0');
ok('saveState round-trips lastCheckedAt',        loaded.lastCheckedAt === 123456);

// Atomic write — no .tmp file left behind
ok('no stale .tmp file after save',
   !fs.existsSync(uc.STATE_FILE + '.tmp'));

// Corrupt state file → graceful fallback
fs.writeFileSync(uc.STATE_FILE, '{not-valid-json');
const recovered = uc.loadState();
ok('corrupt state file falls back to defaults',
   recovered.lastNotifiedVersion === null && recovered.lastCheckedAt === null);

clearState();

// ============================================================================
// formatNotification
// ============================================================================

console.log('\n=== formatNotification ===');

const release1 = {
  tag_name: 'v1.5.0',
  name: 'v1.5.0 — Bootstrap and update checker',
  body: '## Summary\n\n- Added bootstrap installer\n- Added update checker',
  html_url: 'https://github.com/bbesner/claude-telegram-relay/releases/tag/v1.5.0',
};
const notif1 = uc.formatNotification('1.4.0', release1);

ok('notification includes emoji + "Update available"', notif1.includes('🔔') && notif1.includes('Update available'));
ok('notification includes the remote tag',              notif1.includes('v1.5.0'));
ok('notification includes the local version',            notif1.includes('v1.4.0'));
ok('notification includes the release body',             notif1.includes('Added bootstrap installer'));
ok('notification includes the full-notes link',          notif1.includes('https://github.com/bbesner/claude-telegram-relay/releases/tag/v1.5.0'));
ok('notification includes the upgrade bootstrap URL',    notif1.includes('BOOTSTRAP.md'));

// XSS hardening — GitHub release bodies can contain arbitrary text
const release2 = {
  tag_name: 'v1.5.0',
  body: '<script>alert(1)</script> & "quotes"',
  html_url: 'https://example.com/<evil>',
};
const notif2 = uc.formatNotification('1.4.0', release2);
ok('script tag escaped',   notif2.includes('&lt;script&gt;') && !notif2.includes('<script>alert'));
ok('ampersand escaped',    notif2.includes('&amp;'));
ok('URL < escaped',         notif2.includes('&lt;evil&gt;'));

// Long body truncation
const longBody = 'x'.repeat(5000);
const notif3 = uc.formatNotification('1.4.0', { tag_name: 'v2.0.0', body: longBody, html_url: 'https://example.com' });
ok('long body truncated',      notif3.length < 4096, `got length ${notif3.length}`);
ok('long body has ellipsis',   notif3.includes('…'));

// Empty body
const notif4 = uc.formatNotification('1.4.0', { tag_name: 'v2.0.0', body: '', html_url: 'https://example.com' });
ok('empty body still produces valid notification',
   notif4.includes('v2.0.0') && notif4.includes('Full notes:'));

// ============================================================================
// runCheck — end-to-end dependency-injected
// ============================================================================

(async () => {
console.log('\n=== runCheck ===');

// Case 1: Up-to-date
clearState();
let sent = [];
let result = await uc.runCheck({
  localVersion: '1.4.0',
  sendMessage: (text) => { sent.push(text); return Promise.resolve(); },
  fetcher: async () => ({ tag_name: 'v1.4.0', body: '', html_url: 'https://example.com' }),
});
ok('up-to-date returns up-to-date reason', result.reason === 'up-to-date');
ok('up-to-date sends no notification',       sent.length === 0);

// Case 2: Newer release, first time seeing it → notifies
clearState();
sent = [];
result = await uc.runCheck({
  localVersion: '1.4.0',
  sendMessage: (text) => { sent.push(text); return Promise.resolve(); },
  fetcher: async () => ({
    tag_name: 'v1.5.0',
    body: '- new bootstrap\n- new update checker',
    html_url: 'https://github.com/bbesner/claude-telegram-relay/releases/tag/v1.5.0',
  }),
});
ok('newer release returns notified reason', result.reason === 'notified');
ok('newer release sends one message',         sent.length === 1);
ok('message includes the release body',       sent[0].includes('new bootstrap'));
ok('state persisted lastNotifiedVersion',      uc.loadState().lastNotifiedVersion === 'v1.5.0');

// Case 3: Same newer release, second check → does NOT re-notify
sent = [];
result = await uc.runCheck({
  localVersion: '1.4.0',
  sendMessage: (text) => { sent.push(text); return Promise.resolve(); },
  fetcher: async () => ({ tag_name: 'v1.5.0', body: 'same', html_url: 'https://example.com' }),
});
ok('already-notified returns already-notified reason', result.reason === 'already-notified');
ok('already-notified sends no message',                  sent.length === 0);

// Case 4: Even-newer release after notifying the prior one → notifies again
sent = [];
result = await uc.runCheck({
  localVersion: '1.4.0',
  sendMessage: (text) => { sent.push(text); return Promise.resolve(); },
  fetcher: async () => ({ tag_name: 'v1.6.0', body: 'even newer', html_url: 'https://example.com' }),
});
ok('newer-than-last-notified re-notifies', result.reason === 'notified');
ok('new notification sent',                  sent.length === 1);
ok('state updated to latest version',        uc.loadState().lastNotifiedVersion === 'v1.6.0');

// Case 5: Fetch failure → silent, no crash
clearState();
sent = [];
result = await uc.runCheck({
  localVersion: '1.4.0',
  sendMessage: (text) => { sent.push(text); return Promise.resolve(); },
  fetcher: async () => null,
});
ok('fetch failure returns fetch-failed reason', result.reason === 'fetch-failed');
ok('fetch failure sends no message',              sent.length === 0);

// Case 6: No local version (missing VERSION file) → skip gracefully
sent = [];
result = await uc.runCheck({
  localVersion: null,
  sendMessage: (text) => { sent.push(text); return Promise.resolve(); },
  fetcher: async () => ({ tag_name: 'v99.0.0', body: '', html_url: 'https://example.com' }),
});
ok('missing local version skips', result.reason === 'no-local-version' && result.checked === false);

// Case 7: Send failure → reported, not thrown
clearState();
result = await uc.runCheck({
  localVersion: '1.4.0',
  sendMessage: () => Promise.reject(new Error('Telegram down')),
  fetcher: async () => ({ tag_name: 'v1.5.0', body: '', html_url: 'https://example.com' }),
});
ok('send failure returns notify-failed',  result.reason === 'notify-failed');
ok('send failure captures error text',     result.error?.includes('Telegram down'));

// Case 8: UPDATE_CHECK=false → startPeriodicCheck returns null immediately
process.env.UPDATE_CHECK = 'false';
const h = uc.startPeriodicCheck({ localVersion: '1.4.0', fetcher: async () => null });
ok('UPDATE_CHECK=false returns null handle', h === null);
delete process.env.UPDATE_CHECK;

// ============================================================================
// readLocalVersion — reads the real repo VERSION file
// ============================================================================

console.log('\n=== readLocalVersion ===');

const repoRoot = path.resolve(__dirname, '..');
const actual = uc.readLocalVersion(repoRoot);
ok('readLocalVersion returns a non-empty string',
   typeof actual === 'string' && actual.length > 0);
ok('readLocalVersion looks like a semver-ish string',
   /^\d+\.\d+/.test(actual));

// ============================================================================

fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\nupdate-checker: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
