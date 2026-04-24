// v1.6.0: exercise the new metadata helpers on lib/session-manager.js:
// markSessionError, replaceSession, recordCost, plus the enriched setSession.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sm-meta-'));
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'warn';

// Load a fresh copy of session-manager against the scratch HOME
delete require.cache[require.resolve('../lib/session-manager')];
const sm = require('../lib/session-manager');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

function dm(userId) { return { chat: { id: userId, type: 'private' }, from: { id: userId } }; }
const alice = dm(500);

// ---- setSession now stamps status + lastSuccessAt ----
sm.setSession(alice, 'aaa11111-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
let s = sm.getSession(alice);
ok('setSession stamps status=active',             s.status === 'active');
ok('setSession stamps lastSuccessAt',             typeof s.lastSuccessAt === 'string');
ok('setSession lastSuccessAt is ISO-ish',         /^\d{4}-\d{2}-\d{2}T/.test(s.lastSuccessAt));

// ---- markSessionError records error and marks degraded ----
sm.markSessionError(alice, 'session not found', { kind: 'resume-failed' });
s = sm.getSession(alice);
ok('markSessionError sets lastError',             s.lastError === 'session not found');
ok('markSessionError sets lastErrorAt',           typeof s.lastErrorAt === 'string');
ok('markSessionError resume-failed sets lastResumeFailedAt', typeof s.lastResumeFailedAt === 'string');
ok('markSessionError marks degraded',             s.status === 'degraded');

// A subsequent successful setSession clears lastError and restores active
sm.setSession(alice, 'aaa11111-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
s = sm.getSession(alice);
ok('successful turn clears lastError',            s.lastError === null);
ok('successful turn restores status=active',      s.status === 'active');

// ---- markSessionError with unknown chat returns null (no throw) ----
ok('markSessionError on unknown chat returns null',
   sm.markSessionError(dm(9999), 'x') === null);

// ---- replaceSession records previous ID and reason ----
const bob = dm(700);
sm.setSession(bob, 'bbb11111-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
sm.setUserModel(bob, 'sonnet');
sm.replaceSession(bob, 'ccc11111-cccc-cccc-cccc-cccccccccccc',
                  'bbb11111-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                  'user chose /new after resume failure');
const bs = sm.getSession(bob);
ok('replaceSession switches sessionId',
   bs.sessionId === 'ccc11111-cccc-cccc-cccc-cccccccccccc');
ok('replaceSession records previous id',
   bs.replacedPreviousSessionId === 'bbb11111-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
ok('replaceSession records reason',
   bs.replacedReason.includes('user chose /new'));
ok('replaceSession resets messageCount',           bs.messageCount === 0);
ok('replaceSession preserves model',               bs.model === 'sonnet');
ok('replaceSession clears lastError',              bs.lastError === null);
ok('replaceSession stamps replacedAt',             typeof bs.replacedAt === 'string');

// ---- recordCost accumulates ----
sm.setSession(alice, 'aaa11111-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
sm.recordCost(alice, 0.01);
sm.recordCost(alice, 0.02);
s = sm.getSession(alice);
ok('recordCost stores lastCostUsd',                s.lastCostUsd === 0.02);
ok('recordCost accumulates totalCostUsd',          Math.abs(s.totalCostUsd - 0.03) < 1e-9);

// Invalid / zero / negative costs are ignored
const totalBefore = s.totalCostUsd;
sm.recordCost(alice, 0);
sm.recordCost(alice, -5);
sm.recordCost(alice, NaN);
sm.recordCost(alice, null);
sm.recordCost(alice, undefined);
sm.recordCost(alice, 'not a number');
s = sm.getSession(alice);
ok('recordCost ignores non-positive / non-numeric values',
   Math.abs(s.totalCostUsd - totalBefore) < 1e-9);

// recordCost on unknown chat is a no-op (no throw)
sm.recordCost(dm(9999), 0.5);
ok('recordCost on unknown chat is no-op', true);

// ---- Persistence: new fields survive reload ----
delete require.cache[require.resolve('../lib/session-manager')];
const sm2 = require('../lib/session-manager');
const bs2 = sm2.getSession(bob);
ok('replaceSession fields persist across reload',
   bs2.replacedPreviousSessionId === 'bbb11111-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
   && bs2.replacedReason.includes('user chose /new'));
const as2 = sm2.getSession(alice);
ok('cost accounting persists across reload',
   as2.lastCostUsd === 0.02 && Math.abs(as2.totalCostUsd - 0.03) < 1e-9);

console.log(`\nsession-metadata: ${pass} passed, ${fail} failed`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
