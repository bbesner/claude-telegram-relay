# Changelog

All notable changes to this project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.7.0] — 2026-04-24

"Live output" release: the relay now shows you what Claude is doing while
it does it. Instead of a silent 30-second typing dot followed by one big
message, you see a single message that updates in place: **🤔 Thinking…
→ 📖 Using Read /path/to/file.js → 📝 Replying…** and finally the full
answer. Tool-heavy tasks feel dramatically more responsive on a phone.

### Added

- **`streamClaude()` in `lib/claude-cli.js`** — a streaming variant of
  `invokeClaude` that spawns Claude with `--output-format stream-json
  --verbose` and emits normalized, UI-friendly events via an `onEvent`
  callback: `init`, `thinking`, `tool_use`, `tool_result`, `text`,
  `final`, `error`. Resolves with the same shape as `invokeClaude` plus
  a new `toolsUsed` field, and shares the v1.6.0 ACTIVE registry so
  `/interrupt` kills a streaming subprocess exactly like a synchronous
  one.
- **`lib/stream-renderer.js`** — owns the live-edit Telegram message
  lifecycle for one chat turn:
  - Sends a single seed placeholder on the first event
  - Edits it in place as the phase changes (Thinking → Using Tool:X →
    Replying → Done), with per-tool icons (📖 Read, 🔎 Grep, 🖥 Bash,
    ✏ Edit, 🌐 Web*, 🤖 Task, …) and a short summary ("Read /a/b.js",
    "Bash <first line>", "Grep <pattern>")
  - Throttles and coalesces edits (default one edit per ~800 ms) so
    bursty event streams don't hit Telegram's per-chat rate limits
  - `finalize({text})` swaps the seed for the formatted response,
    preserving the v1.4.0 HTML + syntax-highlighted code block rendering
    and spilling into extra messages past the 4096-char Telegram cap
  - `finalizeError(html)` replaces the seed with an explicit error
    message so a "Thinking…" placeholder never lingers after a timeout,
    interrupt, or resume failure
  - `ensureSeed()` memoizes the in-flight send so concurrent callers
    never produce duplicate seed messages
- **`STREAMING` env var (default `true`)** — new opt-out flag. Set
  `STREAMING=false` in `.env` to fall back to the v1.6.0 synchronous
  path. Documented in README and `config/env.example`. Useful escape
  hatch if a future Claude Code release changes the stream-json schema.
- **Tool-name reporting in logs** — `Response sent` log line now
  includes `toolsUsed: [...]` and `streamed: true|false`, so pm2 logs
  show what Claude did during each turn at a glance.
- **Tests (+~45 assertions, 2 new hermetic suites)**:
  - `test/test-stream-claude.js` — fake `claude` binary that writes a
    scripted stream-json sequence (~600 ms) over stdout; verifies
    progressive event arrival, `toolsUsed` capture in order, session id
    discovery, final resolution shape, and clean interrupt mid-stream.
  - `test/test-stream-renderer.js` — mock bot recording every
    `sendMessage`/`editMessageText`; verifies single seed (no dupes
    under concurrency), live edits on tool_use, throttling collapsing
    10 events into ≤3 edits, finalize chunking 7500-char text into
    multiple messages, finalizeError replacing seed, and the
    `summarizeTool`/`toolIcon` helpers.

### Changed

- **`bot.js` main handler** — for text and media messages, invokes
  `streamClaude` through `createRenderer` instead of `invokeClaude` +
  `sendChunkedResponse`. Error paths (interrupt, timeout, resume
  failure) route through `renderer.finalizeError` so the seed message
  is replaced with the explanation, not left dangling next to a
  separate error send.
- **Typing indicator** remains on as a belt-and-suspenders between the
  `enqueue` start and the first event arrival (~200 ms), then becomes
  redundant once the seed message is visible.

### Fixed

- **Falsy-zero bug in `createRenderer`**: `opts.minEditMs ||
  DEFAULT_MIN_EDIT_MS` meant a passed-in `0` was silently replaced with
  the 800 ms default. Now uses `??` so tests (and callers) can disable
  throttling by passing `0` explicitly.

### Tests

- Test suite: 17 suites, ~500 assertions, ~2.4s. Zero new dependencies.

---

## [1.6.0] — 2026-04-24

"Trust" release: the relay no longer silently swaps broken sessions for
fresh ones, surfaces session continuity state clearly, and lets you
cancel work that has gone off the rails. First of several releases laying
the groundwork for durable long-running execution and live output
streaming.

### Added

- **Resume preflight (`lib/session-browser.js:sessionFileExists`)** — before
  spawning Claude with `--resume`, the relay checks that the session's
  `.jsonl` still exists under `~/.claude/projects/`. If it's gone (external
  cleanup, corruption, zero-byte file), the user is told explicitly that
  prior context is unavailable and offered `/new` or `/sessions` — no
  silent fresh start.
- **`/interrupt` (aliases: `/stop`, `/cancel`)** — cancels the in-flight
  Claude subprocess for the current chat without touching session state.
  Backed by a per-chat registry in `lib/claude-cli.js` that holds the child
  process reference until the invocation settles. Safe to call when
  nothing is running — the bot just says so.
- **`/cost`** — shows last-turn and cumulative `total_cost_usd` for the
  current session, pulled straight from Claude CLI's JSON output. Free on
  Max subscriptions, real amounts for API-key runs.
- **Enriched `/info`** — now shows session status (🟢 active / 🟡 degraded),
  whether the transcript is still on disk, last-success timestamp,
  last-error text + timestamp, last-resume-failure timestamp,
  replaced-previous-session id, and cost totals. Also shows active job +
  elapsed time when something is running.
- **New session metadata fields** in `~/.claude-telegram-relay/sessions.json`:
  `status`, `lastSuccessAt`, `lastError`, `lastErrorAt`,
  `lastResumeFailedAt`, `replacedPreviousSessionId`, `replacedReason`,
  `replacedAt`, `lastCostUsd`, `totalCostUsd`. Schema is additive — older
  state files load cleanly.
- **`markSessionError`, `replaceSession`, `recordCost`** helpers on
  `lib/session-manager.js` so future features (job model, recovery flow)
  reuse the same continuity vocabulary.
- **Structured transition logs** at `warn`/`info` for: preflight-miss,
  resume-failed-without-replace, timeout-kill, and subprocess-interrupt.
  All carry `chatId`, `sessionId`, and where relevant `elapsedMs` /
  `timeoutMs` so pm2 logs tell the full continuity story.
- **Tests (+~55 assertions, 3 new hermetic suites)**:
  - `test/test-session-preflight.js` — `sessionFileExists` happy path,
    invalid input, zero-byte files, missing projects dir.
  - `test/test-session-metadata.js` — `markSessionError`, `replaceSession`,
    `recordCost` round-trips + persistence.
  - `test/test-interrupt.js` — real child-process interrupt via a fake
    `claude` binary; verifies `invokeClaude()` resolves with
    `{ interrupted: true }` within seconds of `interruptJob()`.

### Changed

- **`bot.js`: removed the silent fresh-session fallback.** On resume
  failure the relay now sends an explicit warning with recovery options;
  nothing is re-sent to a new session automatically. This is the single
  biggest trust fix in the release.
- **`bot.js`: timeout handling** — user-facing message explains the task
  was terminated (not running in the background), names the timeout, and
  points at `CLAUDE_TIMEOUT_MS` for tuning.
- **`lib/claude-cli.js`: `invokeClaude()` return shape** — now includes
  `timedOut` and `interrupted` booleans so the caller can pick the right
  user-facing copy without string-matching error text. Back-compatible for
  existing fields (`result`, `sessionId`, `cost`, `error`).
- **`lib/commands.js`: lazy-load `claude-cli`** — keeps `commands.js`
  requireable in environments and test runs where the `claude` binary
  isn't on PATH.
- **Bot command menu** registers `/cost` and `/interrupt` so they appear
  in the native `/` autocomplete.

### Tests

- Test suite: 15 suites, ~455 assertions, ~1s. Zero new dependencies.

---

## [1.5.0] — 2026-04-11

Closes the installer and lifecycle loop: new users get a one-line
install command for Claude Code, and existing users get in-bot
notifications when new releases ship.

### Added

- **`BOOTSTRAP.md`** — AI-driven bootstrap installer. Users paste a single line into Claude Code:
  ```
  Read and follow https://raw.githubusercontent.com/bbesner/claude-telegram-relay/main/BOOTSTRAP.md
  ```
  Claude Code fetches the document, recognizes it as an installer script, and walks the user through six phases:
  1. Silent environment detection (Node, PM2, Claude CLI, existing install, optional OpenClaw)
  2. Plain-English summary of what was found
  3. Questionnaire (bot token, Telegram user ID, working directory, optional OpenClaw wiring)
  4. Installation (clone + `install.sh` with flags)
  5. Verification (PM2 status, clean startup log, mandatory phone round-trip test)
  6. Orientation (command list, management commands, config file location)

  Install-only for v1.5.0 — bootstrap-driven upgrade path is a future release.

- **`lib/update-checker.js`** — In-bot release notifier. Runs once on startup (async, non-blocking) and every 24 hours thereafter. Fetches GitHub's `/releases/latest`, compares `tag_name` with the local `VERSION` file, and sends a one-time Telegram message to the admin when a newer version is published.
  - Notification includes the full GitHub release body (truncated to 2500 chars), a direct link, and the bootstrap URL as the upgrade instruction
  - Idempotent: state persisted in `~/.claude-telegram-relay/update-check.json` so the same version is never announced twice
  - Fails silently on network errors, GitHub 404s, and rate limits
  - Never auto-upgrades — just notifies
  - Opt out with `UPDATE_CHECK=false` in `.env`
  - Zero new dependencies (native `https`)

- **`install.sh --openclaw-config <path>`** — New flag that writes `OPENCLAW_CONFIG_PATH` and auto-derives `OPENCLAW_CWD` into the generated `.env`. Used by BOOTSTRAP.md to wire `/memory` in a single install.sh invocation when the user has OpenClaw detected.

- **`UPDATE_CHECK` env var** — Toggles the update notifier. Default `true`. Documented in `config/env.example` and README Configuration table.

- **`test/test-update-checker.js`** — 54 assertions covering `parseVersion`, `isNewer`, state persistence, `formatNotification` HTML escaping, long-body truncation, the full `runCheck` state machine, and `UPDATE_CHECK=false` opt-out.

### Changed

- `bot.js` now starts the update checker inside `bot.getMe().then()` after `setMyCommands` publishes, passing the first `ALLOWED_USER_IDS` entry as the admin recipient.
- `test/test-bot-smoke.js` sets `UPDATE_CHECK=false` so the smoke test doesn't hit the real GitHub API.
- README Quick Start now leads with the bootstrap as the recommended install path; manual `install.sh` remains documented as an alternative.

### Security

- **Removed the author's real Telegram bot token from `BOOTSTRAP.md`** (commit `c4c09a5`). Earlier in the v1.5.0 commit (`8bc3b36`), the BotFather instructions used the author's actual token as a "this is what a token looks like" example, which GitGuardian flagged within 60 seconds of publication. Token was rotated via BotFather's `/revoke` (old token is permanently dead), and the example was replaced with an obviously-fake placeholder (`1234567890:ABCdef...`) plus explicit text clarifying it is not a real token. Not rewriting git history — the leaked token is a dead string and fix-forward is the standard response.

### Tests

- Test suite: 12 suites, **397 assertions**, ~800ms. Zero new dependencies.

---

## [1.4.0] — 2026-04-11

Bundles four mobile-UX improvements for daily use, plus closes the
v1.3.0 `send-message.js` test coverage gap.

### Added

- **Syntax-highlighted code blocks in `lib/formatter.js`** — Fenced code blocks with a language hint (` ```python `, ` ```bash `, etc.) are now emitted as `<pre><code class="language-X">`, which Telegram clients render with native syntax coloring. Whitelist of ~30 languages + common aliases (`js` → javascript, `py` → python, `sh` → bash, `yml` → yaml). Unknown languages fall back to plain `<pre>`. XSS protection (HTML escape of block contents) preserved.

- **`/memory <query>` — OpenClaw memory search passthrough (`lib/openclaw-memory.js`)** — Runs `openclaw memory search <query> --max-results 5 --json` as a subprocess and renders the top results in a phone-readable format. **Zero AI tokens, no Claude round-trip.** Auto-detection:
  1. `OPENCLAW_CONFIG_PATH` env var (explicit override)
  2. `~/.openclaw/openclaw.json` (default install location)

  Binary and cwd independently configurable via `OPENCLAW_BIN` and `OPENCLAW_CWD`. If OpenClaw isn't detected, `/memory` is silently not registered — standalone users never see it. Query passed via argv (no shell interpolation, no injection risk). Results HTML-escaped. Long snippets truncated at 300 chars.

- **Inline keyboard buttons (`lib/callbacks.js`)** — Every Claude response ends with tappable `[+ New]  [💾 Save]  [ℹ Info]` buttons, attached to the **last chunk only**:
  - `+ New` — calls `/new` (clears session)
  - `💾 Save` — uses Telegram's ForceReply to prompt for a label, then labels the current session (5-minute prompt TTL)
  - `ℹ Info` — sends the same payload as `/info`

  Controlled by `INLINE_KEYBOARDS=true|false` (default: `true`). Callback-data strings kept ≤16 bytes (Telegram's hard cap is 64).

- **`/export` — session-to-Markdown (`lib/session-exporter.js`)** — Dumps the active session's JSONL transcript as a clean Markdown document with timestamped user and assistant turns, tool-use lines condensed per-tool (Read/Edit/Write show `file_path`, Bash shows `command`, Grep shows `pattern`, etc.), and truncated tool results as blockquoted code. Sent back as a Telegram document attachment. User entries that are only `tool_result` echoes are deduplicated.

- **New env vars** in `config/env.example` and the README Configuration table:
  - `INLINE_KEYBOARDS` (default: `true`)
  - `OPENCLAW_CONFIG_PATH` (default: auto-detect from `~/.openclaw/openclaw.json`)
  - `OPENCLAW_BIN` (default: `openclaw` from PATH)
  - `OPENCLAW_CWD` (default: config parent dir)
  - `OPENCLAW_SEARCH_TIMEOUT_MS` (default: `90000` — see 1.4.0 follow-up fix below)

- **New test suites**:
  - `test/test-formatter.js` — 45 assertions
  - `test/test-openclaw-memory.js` — 40 assertions
  - `test/test-memory-command.js` — 14 assertions
  - `test/test-callbacks.js` — 34 assertions
  - `test/test-session-exporter.js` — 48 assertions
  - `test/test-export-command.js` — 14 assertions
  - `test/test-send-message.js` — 39 assertions (closes the v1.3.0 coverage gap)

### Fixed

- **`/memory` cold-cache timeout** — Earlier v1.4.0 shipped with a 15-second default timeout for `searchMemory`, which was too short for the first query after a bot restart against a large semantic memory index (e.g. Ari's Gemini+LanceDB setup legitimately takes 30–90s on cold warmup). Bumped default to 90 seconds, added `OPENCLAW_SEARCH_TIMEOUT_MS` env var, and made the typing indicator refresh every 4s during the wait so users see continuous feedback instead of a frozen chat.

- **`/export` `.md` files unopenable on Android** — `.md` has no default MIME handler on Android's share sheet, so tapping the exported file offered no text viewers. Fixed by sending the document with `filename: session-XXXXXXXX.txt` and `contentType: 'text/plain'`. File contents are still Markdown — anyone who wants to render them can rename the extension — but on the chat itself, tapping the attachment now routes through Android's native text viewer.

### Changed

- `/help` and `/start` conditionally list `/memory` only when OpenClaw is detected.
- `bot.js` conditionally appends `/memory` to the `setMyCommands` array when OpenClaw is detected, so the native Telegram menu stays clean for standalone users.
- `sendChunkedResponse` in `bot.js` now attaches the inline keyboard to the last chunk of a multi-chunk response only.

### Tests

- Test suite: 11 suites, **343 assertions**, ~800ms. Zero new dependencies.

---

## [1.3.0] — 2026-04-11

### Added

- **`scripts/send-message.sh`** — Outbound message helper. Lets any process on the server send a Telegram notification through your bot, reusing the relay's existing `.env`.
  - Reads bot token + default chat ID from `.env` (or environment overrides)
  - Supports `--chat-id`, `--file`, `--stdin`, `--title`, `--parse-mode` flags
  - Auto-chunks messages over ~3800 chars at paragraph/line/word boundaries
  - Resolves default chat ID from `DEFAULT_CHAT_ID` env var or first entry in `ALLOWED_USER_IDS`
  - Validates chat ID is numeric, fails fast on missing token
  - Exits 0 success / 1 missing args / 2 send failure

- **`lib/send-message.js`** — Node.js module exposing the same functionality:
  ```js
  const { sendMessage } = require('./lib/send-message');
  await sendMessage('Build complete', { title: '✅ Deploy', parseMode: 'Markdown' });
  ```
  - Returns array of `message_id`s (one per chunk for long messages)
  - Throws on failure with descriptive error
  - Pure stdlib (`https`, `JSON`) — no extra dependencies
  - Exports `chunkMessage` and `getDefaultChatId` for testing

- **Convenience symlink in installer** — `install.sh` now creates `$WORKING_DIR/scripts/tg-send` → `send-message.sh` so you can call it with a short path from anywhere.

- **README "Sending Outbound Messages" section** — Documents shell + Node usage, default chat ID resolution, common patterns (cron, hooks, Claude Code), and security considerations.

- **CHANGELOG.md** — First versioned changelog. Previous releases (1.0.0 through 1.2.0) were not formally tracked here.

### Changed

- `install.sh` now copies the `scripts/` directory into the install target and chmods the shell scripts executable.
- `install.sh` install summary now mentions the `tg-send` symlink and shows usage examples.

### Use cases

- **Cron job notifications**: `0 4 * * * /path/to/backup.sh && bash ~/scripts/tg-send "Backup OK"`
- **Build/deploy hooks**: `bash ~/scripts/tg-send --title "Deployed" "Build #42 succeeded"`
- **Pipe generated reports**: `my-status.sh | bash ~/scripts/tg-send --stdin --title "Daily status"`
- **Claude Code notifications**: When the user explicitly asks Claude Code to notify on completion of a long task

### Security

The script reads the bot token from your gitignored `.env` file. Anyone who can execute `send-message.sh` on your server can send messages from your bot. Treat the script the same way you'd treat the `.env` file: server-local, owner-readable, never exposed over a network.

---

## [1.2.0] — 2026-04-10

Session browser, cross-interface resume, session labeling, native command menu.

### Added

- **`/sessions`** — Lists up to 20 recent Claude Code sessions across all project buckets in `~/.claude/projects/`, newest first, with 📱 marker for relay-started sessions.
- **`/resume <n|id|partial|label>`** — Resumes any session by list index, full/partial UUID, or saved label (case-insensitive).
- **`/save <name>`** — Labels the current session under `sessions._named` for instant recall later. Labels survive `/new`, bot restarts, and even rollbacks.
- **`/info`** — Now shows full session UUID plus a `Resumed:` timestamp when a session was resumed.
- **Native Telegram command menu** — `bot.setMyCommands` publishes the full command list to Telegram on startup, so users get a `/` autocomplete dropdown and a populated Menu button without any BotFather configuration.
- **Initial test suite** — 106 hermetic assertions across 4 suites covering session browser, session manager, command handlers, and bot startup.
- **CI** — GitHub Actions workflow matrix-testing Node 18/20/22 on every push and PR.
- **`package.json` metadata** — `repository`, `bugs`, `homepage`, `engines: {node: ">=18"}`.

See [v1.2.0 release notes](https://github.com/bbesner/claude-telegram-relay/releases/tag/v1.2.0) for the full details.

## [1.1.0] — 2026-04-09

FlipClaw rename, documentation polish, and contributor hygiene.

See [git log v1.0.0..v1.1.0](https://github.com/bbesner/claude-telegram-relay/compare/v1.0.0...v1.1.0) for details.

## [1.0.0] — 2026-04-08

Initial public release. Core features:

- Telegram → Claude Code CLI message relay via polling
- Bot token + allowed user IDs authorization
- Per-chat session persistence in `~/.claude-telegram-relay/sessions.json`
- Markdown → Telegram HTML formatter
- Long-message chunking
- Media support (photos, PDFs, documents)
- Group chat `@mention` mode
- PM2-managed service with `install.sh`
