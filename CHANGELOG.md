# Changelog

All notable changes to this project will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

Pre-changelog release. See `git log v1.1.0..v1.2.0` for details.

## [1.1.0] — 2026-04-09

Pre-changelog release.

## [1.0.0] — 2026-04-08

Initial public release.
