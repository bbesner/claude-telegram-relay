// Exercises lib/session-manager.js with a scratch HOME. Self-contained —
// does not touch any real state.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-sm-'));
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'warn';

const sm = require('../lib/session-manager');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

function dmMsg(userId)       { return { chat: { id: userId, type: 'private' },  from: { id: userId } }; }
function groupMsg(cid, uid)  { return { chat: { id: cid,    type: 'group'   }, from: { id: uid } }; }

const alice = dmMsg(100);
const bob   = dmMsg(200);
const group = groupMsg(-1001, 100);

// ---- 1: sessionKey DM vs group ----
ok('sessionKey DM',    sm.sessionKey(alice) === 'user:100');
ok('sessionKey group', sm.sessionKey(group) === 'group:-1001');

// ---- 2: setSession + setSessionById ----
sm.setSession(alice, 'aaa11111-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
let s = sm.getSession(alice);
ok('setSession created', s.sessionId === 'aaa11111-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
ok('setSession messageCount = 1', s.messageCount === 1);

sm.setSession(alice, 'aaa11111-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
s = sm.getSession(alice);
ok('setSession increments count', s.messageCount === 2);

sm.setSessionById(alice, 'bbb22222-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
s = sm.getSession(alice);
ok('setSessionById switches id',     s.sessionId === 'bbb22222-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
ok('setSessionById preserves count', s.messageCount === 2);
ok('setSessionById sets resumedAt',  typeof s.resumedAt === 'string');

// ---- 3: saveSessionLabel + getSessionByLabel ----
const saved = sm.saveSessionLabel(alice, 'Sck-Migration');
ok('saveSessionLabel returns true',              saved === true);
ok('getSessionByLabel exact',                    sm.getSessionByLabel('Sck-Migration') === 'bbb22222-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
ok('getSessionByLabel case-insensitive',         sm.getSessionByLabel('sck-migration') === 'bbb22222-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
ok('getSessionByLabel unknown returns null',     sm.getSessionByLabel('nope') === null);

// ---- 4: getAllRelaySessionIds across chats, excluding _named ----
sm.setSession(bob,   'ccc33333-cccc-cccc-cccc-cccccccccccc');
sm.setSession(group, 'ddd44444-dddd-dddd-dddd-dddddddddddd');
const ids = sm.getAllRelaySessionIds();
ok('ids include alice', ids.has('bbb22222-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
ok('ids include bob',   ids.has('ccc33333-cccc-cccc-cccc-cccccccccccc'));
ok('ids include group', ids.has('ddd44444-dddd-dddd-dddd-dddddddddddd'));
ok('ids size = 3',      ids.size === 3);

// ---- 5: setSessionListing + getSessionFromListing ----
const fakeList = [
  { sessionId: 'aaa00000-0000-0000-0000-000000000000' },
  { sessionId: 'bbb00000-0000-0000-0000-000000000000' },
  { sessionId: 'ccc00000-0000-0000-0000-000000000000' },
];
sm.setSessionListing(alice, fakeList);
ok('getSessionFromListing #1',         sm.getSessionFromListing(alice, 1) === 'aaa00000-0000-0000-0000-000000000000');
ok('getSessionFromListing #3',         sm.getSessionFromListing(alice, 3) === 'ccc00000-0000-0000-0000-000000000000');
ok('getSessionFromListing 0 => null',  sm.getSessionFromListing(alice, 0) === null);
ok('getSessionFromListing 99 => null', sm.getSessionFromListing(alice, 99) === null);

const carol = dmMsg(300);
ok('getSessionFromListing on new user => null', sm.getSessionFromListing(carol, 1) === null);

// ---- 6: setSessionById preserves _lastListing ----
sm.setSessionById(alice, 'eee55555-eeee-eeee-eeee-eeeeeeeeeeee');
ok('_lastListing preserved after /resume', sm.getSessionFromListing(alice, 2) === 'bbb00000-0000-0000-0000-000000000000');

// ---- 7: setSessionListing on fresh user ----
sm.setSessionListing(carol, fakeList);
ok('setSessionListing on new user works', sm.getSessionFromListing(carol, 2) === 'bbb00000-0000-0000-0000-000000000000');

// ---- 8: Persistence — reload and verify state survives ----
delete require.cache[require.resolve('../lib/session-manager')];
const sm2 = require('../lib/session-manager');
ok('persisted label survives reload',   sm2.getSessionByLabel('Sck-Migration') === 'bbb22222-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
ok('persisted alice session reloaded',  sm2.getSession(alice)?.sessionId === 'eee55555-eeee-eeee-eeee-eeeeeeeeeeee');
ok('persisted alice listing reloaded',  sm2.getSessionFromListing(alice, 3) === 'ccc00000-0000-0000-0000-000000000000');

// ---- 9: clearSession drops the chat entry, preserves labels ----
sm2.clearSession(alice);
ok('clearSession removes chat',      sm2.getSession(alice) === null);
ok('clearSession drops listing',     sm2.getSessionFromListing(alice, 1) === null);
ok('clearSession preserves labels',  sm2.getSessionByLabel('Sck-Migration') === 'bbb22222-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

// ---- 10: saveSessionLabel no session => false ----
const dave = dmMsg(400);
ok('saveSessionLabel with no session => false', sm2.saveSessionLabel(dave, 'x') === false);

// ---- 11: setUserModel round-trip ----
sm2.setSession(alice, 'fff66666-ffff-ffff-ffff-ffffffffffff');
sm2.setUserModel(alice, 'sonnet');
ok('getUserModel returns sonnet', sm2.getUserModel(alice) === 'sonnet');
sm2.setUserModel(alice, null);
ok('setUserModel null resets',    sm2.getUserModel(alice) === null);

console.log(`\nsession-manager: ${pass} passed, ${fail} failed`);
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
