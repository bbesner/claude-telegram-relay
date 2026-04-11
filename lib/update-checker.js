// ============================================================================
// lib/update-checker.js — Notify the admin when a new release is published.
//
// Runs on bot startup and once every 24h afterward. Fetches the latest
// release from the GitHub API, compares tag_name with the local VERSION,
// and sends a one-time Telegram message to the first ALLOWED_USER_IDS
// entry when a newer version is found.
//
// Design properties:
//   - Zero new dependencies (native https).
//   - Fails silently on network errors, DNS failures, GitHub 404s, rate
//     limits, etc. — never crashes the bot, only logs at warn level.
//   - Persists "last-notified version" in ~/.claude-telegram-relay/update-check.json
//     so we don't notify twice for the same release, even across restarts.
//   - Controlled by UPDATE_CHECK env var (default: "true"). Set to "false"
//     to opt out entirely — the checker becomes a no-op.
//   - Never auto-upgrades. The message tells the user exactly how to do it.
// ============================================================================

const fs  = require('fs');
const os  = require('os');
const path = require('path');
const https = require('https');
const log = require('./logger');

const REPO = 'bbesner/claude-telegram-relay';
const STATE_DIR  = path.join(os.homedir(), '.claude-telegram-relay');
const STATE_FILE = path.join(STATE_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
// Keep the notification body under Telegram's 4096-char limit comfortably.
// GitHub release bodies can be huge; we truncate at this length and append
// "… (see full notes)".
const MAX_BODY_CHARS = 2500;

/**
 * Read the local VERSION file. Returns the version string (e.g. "1.4.0"),
 * or null on any error. This is the authoritative "what are we running"
 * signal — don't rely on package.json because it can drift from git tags.
 */
function readLocalVersion(repoRoot) {
  try {
    const p = path.join(repoRoot || path.resolve(__dirname, '..'), 'VERSION');
    const raw = fs.readFileSync(p, 'utf8');
    const first = raw.split('\n')[0].trim();
    return first || null;
  } catch (e) {
    log.warn('update-checker: could not read VERSION', { error: e.message });
    return null;
  }
}

/**
 * Parse "v1.2.3" or "1.2.3" into [1, 2, 3]. Pre-release suffixes (e.g.
 * "1.2.3-beta.1") are ignored for comparison purposes — a pre-release of
 * a higher version still beats a lower version, which is the behavior
 * we want for a "should I notify" check.
 */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const stripped = v.replace(/^v/i, '').split(/[-+]/)[0]; // drop pre-release/metadata
  const parts = stripped.split('.').map(n => parseInt(n, 10));
  if (parts.length < 1 || parts.some(n => Number.isNaN(n))) return null;
  // Normalize to [major, minor, patch]
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

/**
 * Returns true iff `remote` is strictly newer than `local`.
 * Both args are strings like "1.4.0" or "v1.5.0-beta.1".
 */
function isNewer(remote, local) {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] > l[i]) return true;
    if (r[i] < l[i]) return false;
  }
  return false;
}

/**
 * Load the last-notified version + last-check timestamp from disk.
 * Returns { lastNotifiedVersion: string|null, lastCheckedAt: number|null }.
 * Never throws — returns defaults on any error.
 */
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { lastNotifiedVersion: null, lastCheckedAt: null };
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    log.warn('update-checker: could not read state', { error: e.message });
    return { lastNotifiedVersion: null, lastCheckedAt: null };
  }
}

/**
 * Save state atomically (tmp + rename so a crash mid-write doesn't corrupt).
 */
function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.warn('update-checker: could not save state', { error: e.message });
  }
}

/**
 * Fetch the latest release from GitHub. Returns:
 *   { tag_name, name, body, html_url }
 * Or null on failure (no exceptions bubbled up).
 */
function fetchLatestRelease() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: 'api.github.com',
        path: `/repos/${REPO}/releases/latest`,
        method: 'GET',
        headers: {
          'User-Agent': 'claude-telegram-relay-update-checker',
          'Accept': 'application/vnd.github+json',
        },
        timeout: 10_000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            log.warn('update-checker: GitHub returned non-200', { status: res.statusCode });
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(data);
            resolve({
              tag_name: json.tag_name,
              name: json.name || json.tag_name,
              body: json.body || '',
              html_url: json.html_url || `https://github.com/${REPO}/releases/tag/${json.tag_name}`,
            });
          } catch (e) {
            log.warn('update-checker: failed to parse GitHub response', { error: e.message });
            resolve(null);
          }
        });
      }
    );
    req.on('error', (e) => {
      log.warn('update-checker: request failed', { error: e.message });
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      log.warn('update-checker: request timed out');
      resolve(null);
    });
    req.end();
  });
}

/**
 * Escape HTML for the Telegram notification (parse_mode: HTML).
 */
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the Telegram notification body. Returns a string with HTML markup.
 * The full release body is included (truncated if very long) plus the link.
 */
function formatNotification(local, release) {
  const lines = [
    `🔔 <b>Update available: ${escapeHtml(release.tag_name)}</b>`,
    `You're running <code>v${escapeHtml(local)}</code>.`,
    '',
  ];

  // Include the release body — GitHub Markdown is close enough to plaintext
  // that truncating and escaping is the sensible approach here. Telegram
  // won't render the markdown as HTML, but the text is still readable.
  const body = (release.body || '').trim();
  if (body) {
    let excerpt = body;
    if (excerpt.length > MAX_BODY_CHARS) {
      excerpt = excerpt.slice(0, MAX_BODY_CHARS).trimEnd() + '…';
    }
    lines.push('<b>Release notes:</b>');
    lines.push(escapeHtml(excerpt));
    lines.push('');
  }

  lines.push(`<b>Full notes:</b> ${escapeHtml(release.html_url)}`);
  lines.push('');
  lines.push('<b>To upgrade</b>, paste this into Claude Code:');
  lines.push(`<code>Read and follow https://raw.githubusercontent.com/${REPO}/main/BOOTSTRAP.md</code>`);

  return lines.join('\n');
}

/**
 * Run one check. If a newer release is found and we haven't already
 * notified about it, send a Telegram message to the admin. Updates state.
 *
 * @param {object} deps
 * @param {function} deps.sendMessage  async (text) => void  — must handle
 *                                     its own targeting (we pass the admin
 *                                     chat ID in)
 * @param {string}   deps.localVersion Override for the local VERSION string
 *                                     (used by tests; production passes null
 *                                     and we read it from disk)
 * @param {function} [deps.fetcher]    Override for the GitHub fetcher (tests)
 * @param {function} [deps.now]        Override for Date.now() (tests)
 */
async function runCheck(deps = {}) {
  const fetcher      = deps.fetcher      || fetchLatestRelease;
  const now          = deps.now          || (() => Date.now());
  // Distinguish "caller didn't pass localVersion at all" (use disk) from
  // "caller explicitly passed null" (test-driven assertion of the
  // no-local-version branch). Only fall back to disk when the property
  // isn't on the deps object.
  const local = ('localVersion' in deps) ? deps.localVersion : readLocalVersion();
  const sendMessage  = deps.sendMessage;

  if (!local) {
    log.debug('update-checker: no local version, skipping');
    return { checked: false, reason: 'no-local-version' };
  }

  const state = loadState();
  const release = await fetcher();
  saveState({ ...state, lastCheckedAt: now() });

  if (!release || !release.tag_name) {
    return { checked: true, reason: 'fetch-failed' };
  }

  if (!isNewer(release.tag_name, local)) {
    return { checked: true, reason: 'up-to-date', localVersion: local, remoteVersion: release.tag_name };
  }

  // Already notified about this specific version?
  if (state.lastNotifiedVersion === release.tag_name) {
    return { checked: true, reason: 'already-notified', localVersion: local, remoteVersion: release.tag_name };
  }

  // Fire the notification
  if (typeof sendMessage === 'function') {
    try {
      await sendMessage(formatNotification(local, release));
      saveState({ lastNotifiedVersion: release.tag_name, lastCheckedAt: now() });
      log.info('update-checker: notified', { local, remote: release.tag_name });
      return { checked: true, reason: 'notified', localVersion: local, remoteVersion: release.tag_name };
    } catch (e) {
      log.warn('update-checker: notification failed', { error: e.message });
      return { checked: true, reason: 'notify-failed', error: e.message };
    }
  }

  return { checked: true, reason: 'would-notify', localVersion: local, remoteVersion: release.tag_name };
}

/**
 * Start the periodic check loop. Runs once immediately, then every 24h.
 * Returns the interval handle so callers can clear it during shutdown
 * (bot.js doesn't currently bother since process exit kills it, but tests
 * can use it to avoid leaking handles).
 *
 * @param {object} deps  Same shape as runCheck's deps
 * @param {number} [deps.intervalMs=CHECK_INTERVAL_MS]
 */
function startPeriodicCheck(deps = {}) {
  if (process.env.UPDATE_CHECK === 'false') {
    log.info('update-checker: disabled via UPDATE_CHECK=false');
    return null;
  }

  const intervalMs = deps.intervalMs || CHECK_INTERVAL_MS;

  // Fire the first check async — don't block startup on it
  runCheck(deps).catch((e) => {
    log.warn('update-checker: first-run failed', { error: e.message });
  });

  const handle = setInterval(() => {
    runCheck(deps).catch((e) => {
      log.warn('update-checker: periodic run failed', { error: e.message });
    });
  }, intervalMs);

  // Don't keep the process alive just for the update check — allow the
  // event loop to exit if everything else is done.
  if (handle.unref) handle.unref();

  return handle;
}

module.exports = {
  startPeriodicCheck,
  runCheck,
  // Exported for testing
  parseVersion,
  isNewer,
  readLocalVersion,
  loadState,
  saveState,
  formatNotification,
  fetchLatestRelease,
  CHECK_INTERVAL_MS,
  STATE_FILE,
};
