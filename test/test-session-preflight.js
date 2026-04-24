// v1.6.0: test lib/session-browser.js:sessionFileExists — the resume preflight
// that decides whether a sessionId can still be resumed before we spawn Claude.
const fs = require('fs');
const path = require('path');
const { createFixtureHome, cleanupFixtureHome, IDS } = require('./fixtures');

const fx = createFixtureHome();
process.env.HOME = fx.home;
process.env.LOG_LEVEL = 'warn';

// Clear require cache so session-browser picks up the scratch HOME
delete require.cache[require.resolve('../lib/session-browser')];
const { sessionFileExists } = require('../lib/session-browser');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// ---- Happy path: known fixture sessions exist ----
ok('fixture session A exists',  sessionFileExists(IDS.A) === true);
ok('fixture session B exists',  sessionFileExists(IDS.B) === true);
ok('fixture session C exists (different bucket)', sessionFileExists(IDS.C) === true);

// ---- Unknown session ----
ok('unknown UUID returns false',
   sessionFileExists('deadbeef-1111-2222-3333-444455556666') === false);

// ---- Invalid inputs ----
ok('null returns false',         sessionFileExists(null)      === false);
ok('undefined returns false',    sessionFileExists(undefined) === false);
ok('empty string returns false', sessionFileExists('')        === false);
ok('non-UUID string false',      sessionFileExists('not-a-uuid') === false);
ok('partial UUID prefix false',  sessionFileExists(IDS.A.slice(0, 8)) === false);

// ---- Zero-byte file should be treated as missing (corrupt/empty) ----
const zeroId = '00000000-0000-0000-0000-000000000000';
const firstBucket = fs.readdirSync(fx.projects)[0];
fs.writeFileSync(path.join(fx.projects, firstBucket, zeroId + '.jsonl'), '');
ok('zero-byte session file is treated as missing',
   sessionFileExists(zeroId) === false);

// ---- Projects dir absent: returns false, doesn't throw ----
const emptyHome = fs.mkdtempSync(require('os').tmpdir() + '/relayhome-empty-');
const prevHome = process.env.HOME;
process.env.HOME = emptyHome;
delete require.cache[require.resolve('../lib/session-browser')];
const { sessionFileExists: sfe2 } = require('../lib/session-browser');
ok('missing ~/.claude/projects returns false (no throw)',
   sfe2(IDS.A) === false);
fs.rmSync(emptyHome, { recursive: true, force: true });
process.env.HOME = prevHome;

console.log(`\nsession-preflight: ${pass} passed, ${fail} failed`);
cleanupFixtureHome(fx);
process.exit(fail === 0 ? 0 : 1);
