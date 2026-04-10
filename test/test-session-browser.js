// Exercises lib/session-browser.js against a hermetic fixture HOME.
// Safe to run in CI — no dependency on the host's real Claude Code sessions.
const { createFixtureHome, cleanupFixtureHome, IDS } = require('./fixtures');

const fx = createFixtureHome();
process.env.HOME = fx.home;
process.env.LOG_LEVEL = 'warn';

// Require AFTER setting HOME — session-browser captures PROJECTS_DIR at load time.
const { listAllSessions, formatSessionList } = require('../lib/session-browser');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// --- 1: listAllSessions returns exactly the 4 fixture sessions ---
const sessions = listAllSessions(new Set());
ok('returns 4 UUID-named sessions', sessions.length === 4, `got ${sessions.length}`);

// --- 2: newest-first sort order (A, C, D, B) ---
ok('order[0] = A (newest)',       sessions[0]?.sessionId === IDS.A);
ok('order[1] = C (60s old)',      sessions[1]?.sessionId === IDS.C);
ok('order[2] = D (1h old)',       sessions[2]?.sessionId === IDS.D);
ok('order[3] = B (1d old)',       sessions[3]?.sessionId === IDS.B);

// --- 3: the non-UUID file (summary.jsonl) is NOT in the results ---
const sawNonUuid = sessions.some(s => s.sessionId === 'summary');
ok('non-UUID jsonl file ignored', !sawNonUuid);

// --- 4: bucketLabel resolution ---
const sessionA = sessions.find(s => s.sessionId === IDS.A);
const sessionC = sessions.find(s => s.sessionId === IDS.C);
ok('bucketLabel for A is "~"',       sessionA?.bucketLabel === '~', `got ${sessionA?.bucketLabel}`);
ok('bucketLabel for C is "~/ari"',   sessionC?.bucketLabel === '~/ari', `got ${sessionC?.bucketLabel}`);

// --- 5: snippet extraction — array-style content path ---
ok('A snippet extracted from array content',
   typeof sessionA?.snippet === 'string' && sessionA.snippet.startsWith('Fixture session A'));

// --- 6: snippet extraction — string-style content path ---
const sessionB = sessions.find(s => s.sessionId === IDS.B);
ok('B snippet extracted from string content',
   sessionB?.snippet === 'Fixture session B — string-style content path');

// --- 7: local-command-caveat is skipped, next message wins ---
const sessionD = sessions.find(s => s.sessionId === IDS.D);
ok('D skipped caveat and found real text',
   sessionD?.snippet?.startsWith('Fixture session D — real content after'),
   `got ${sessionD?.snippet}`);

// --- 8: isFromRelay marker ---
const fakeRelay = new Set([IDS.A, IDS.D]);
const marked = listAllSessions(fakeRelay);
const markedCount = marked.filter(s => s.isFromRelay).length;
ok('isFromRelay = 2 when relay set contains A+D', markedCount === 2);
ok('A marked as relay',     marked.find(s => s.sessionId === IDS.A)?.isFromRelay === true);
ok('C NOT marked as relay', marked.find(s => s.sessionId === IDS.C)?.isFromRelay === false);

// --- 9: formatSessionList empty state ---
ok('empty list returns empty message', formatSessionList([]) === 'No Claude Code sessions found.');

// --- 10: formatSessionList renders HTML and escapes user input ---
const html = formatSessionList([{
  sessionId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  bucket: '-home-ubuntu',
  bucketLabel: '~',
  mtime: Date.now(),
  sizeKb: 1,
  snippet: '<script>alert("xss")</script> & "quotes"',
  isFromRelay: false,
}]);
ok('output contains Recent Claude Code Sessions header', html.includes('Recent Claude Code Sessions'));
ok('<script> tag escaped',  !html.includes('<script>') && html.includes('&lt;script&gt;'));
ok('& escaped',              html.includes('&amp;'));
ok('eeeeeeee ID rendered',   html.includes('eeeeeeee'));

// --- 11: formatSessionList shows 📱 marker for relay sessions ---
const htmlWithRelay = formatSessionList([{
  sessionId: IDS.A, bucket: '-home-ubuntu', bucketLabel: '~',
  mtime: Date.now(), sizeKb: 1, snippet: 'hi', isFromRelay: true,
}]);
ok('📱 marker rendered when isFromRelay=true', htmlWithRelay.includes('📱'));

// --- 12: age labels ---
const oneHourAgo = Date.now() - 3_600_000;
const oneDayAgo  = Date.now() - 86_400_000 - 60_000;
const twoDaysAgo = Date.now() - 2 * 86_400_000;
const ageHtml = formatSessionList([
  { sessionId: 'aaaaaaaa-0000-0000-0000-000000000000', bucket: '-home-ubuntu', bucketLabel: '~', mtime: Date.now(), sizeKb: 1, snippet: 'now',  isFromRelay: false },
  { sessionId: 'bbbbbbbb-0000-0000-0000-000000000000', bucket: '-home-ubuntu', bucketLabel: '~', mtime: oneHourAgo, sizeKb: 1, snippet: '1h',   isFromRelay: false },
  { sessionId: 'cccccccc-0000-0000-0000-000000000000', bucket: '-home-ubuntu', bucketLabel: '~', mtime: oneDayAgo,  sizeKb: 1, snippet: 'yest', isFromRelay: false },
  { sessionId: 'dddddddd-0000-0000-0000-000000000000', bucket: '-home-ubuntu', bucketLabel: '~', mtime: twoDaysAgo, sizeKb: 1, snippet: '2d',   isFromRelay: false },
]);
ok('age label "just now"',  ageHtml.includes('just now'));
ok('age label "1h ago"',    ageHtml.includes('1h ago'));
ok('age label "yesterday"', ageHtml.includes('yesterday'));
ok('age label "2d ago"',    ageHtml.includes('2d ago'));

console.log(`\nsession-browser: ${pass} passed, ${fail} failed`);
cleanupFixtureHome(fx);
process.exit(fail === 0 ? 0 : 1);
