// Test fixtures: build a hermetic fake $HOME with a fake ~/.claude/projects/
// that contains known session files. Tests can then point session-browser and
// session-manager at this scratch HOME and get deterministic results — no
// dependency on the host machine having real Claude Code sessions.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Stable, predictable UUIDs so tests can assert against them by name.
const IDS = {
  // Newest session in -home-ubuntu: array-style content with real text
  A: 'a1111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  // Older session in -home-ubuntu: string-style content
  B: 'b2222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  // Session in a different bucket (-home-ubuntu-ari)
  C: 'c3333333-cccc-cccc-cccc-cccccccccccc',
  // Session whose first user message is a local-command-caveat (should be
  // skipped by extractFirstUserMessage)
  D: 'd4444444-dddd-dddd-dddd-dddddddddddd',
};

const NOW = Date.now();

function writeJsonl(filePath, lines) {
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

/**
 * Create a scratch HOME with a populated .claude/projects/ tree and return the
 * handles tests will need. Caller is responsible for calling cleanup().
 */
function createFixtureHome() {
  // Prefix must have no hyphens, because Claude Code's bucket-naming scheme
  // (/=>-, .=>-) is lossy and session-browser's bucketLabel() reverses it.
  // A hyphen-free HOME like /tmp/relayhomeAb3xZq round-trips cleanly; a
  // hyphenated HOME like /tmp/relay-test-XXX would decode into a bogus path
  // and defeat the ~-resolution check.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relayhome'));
  const projects = path.join(home, '.claude', 'projects');

  // Encode the scratch HOME into a bucket name the way Claude Code does.
  const encodeBucket = (p) => p.replace(/[/.]/g, '-');
  const homeBucket = encodeBucket(home);          // e.g. -tmp-relayhomeAb3xZq
  const ariBucket  = encodeBucket(home + '/ari'); // same + '-ari'

  // --- Bucket 1: the fixture HOME itself (expected bucketLabel = "~") ---
  const bucket1 = path.join(projects, homeBucket);
  fs.mkdirSync(bucket1, { recursive: true });

  // Session A (newest): array-style content
  writeJsonl(path.join(bucket1, IDS.A + '.jsonl'), [
    { type: 'user', message: { content: [{ type: 'text', text: 'Fixture session A — newest entry with a fairly long snippet to verify truncation at eighty chars max.' }] } },
    { type: 'assistant', message: { content: 'ok' } },
  ]);

  // Session B (older): string-style content
  writeJsonl(path.join(bucket1, IDS.B + '.jsonl'), [
    { type: 'user', message: { content: 'Fixture session B — string-style content path' } },
  ]);

  // Session D: local-command-caveat first, real text second
  writeJsonl(path.join(bucket1, IDS.D + '.jsonl'), [
    { type: 'user', message: { content: '<local-command-caveat>ignore this</local-command-caveat>' } },
    { type: 'user', message: { content: [{ type: 'text', text: 'Fixture session D — real content after a caveat' }] } },
  ]);

  // A non-UUID file that session-browser must ignore
  fs.writeFileSync(path.join(bucket1, 'summary.jsonl'), '{"not":"a session"}\n');

  // --- Bucket 2: HOME/ari (expected bucketLabel = "~/ari") ---
  const bucket2 = path.join(projects, ariBucket);
  fs.mkdirSync(bucket2, { recursive: true });

  writeJsonl(path.join(bucket2, IDS.C + '.jsonl'), [
    { type: 'user', message: { content: [{ type: 'text', text: 'Fixture session C — in the ari bucket' }] } },
  ]);

  // --- Force mtimes so ordering is deterministic across runs ---
  // Newest -> oldest: A, C, D, B
  const sec = (ms) => ms / 1000;
  fs.utimesSync(path.join(bucket1, IDS.A + '.jsonl'), sec(NOW),              sec(NOW));
  fs.utimesSync(path.join(bucket2, IDS.C + '.jsonl'), sec(NOW - 60_000),     sec(NOW - 60_000));
  fs.utimesSync(path.join(bucket1, IDS.D + '.jsonl'), sec(NOW - 3_600_000),  sec(NOW - 3_600_000));
  fs.utimesSync(path.join(bucket1, IDS.B + '.jsonl'), sec(NOW - 86_400_000), sec(NOW - 86_400_000));

  return { home, projects, ids: IDS };
}

function cleanupFixtureHome(fx) {
  if (fx && fx.home) fs.rmSync(fx.home, { recursive: true, force: true });
}

module.exports = { createFixtureHome, cleanupFixtureHome, IDS };
