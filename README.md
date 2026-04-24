# claude-telegram-relay

> Built by [Brad Besner](https://github.com/bbesner) · [Ultraweb Labs](https://ultraweblabs.com) · [⭐ Star on GitHub](https://github.com/bbesner/claude-telegram-relay)

Talk to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from your phone. Send a Telegram message, get a full Claude Code response back — using your existing Max subscription with zero per-token relay cost.

```
You (Telegram) → Bot (this relay) → claude -p → response → Bot → You
```

The relay is a pure message shuttle — **zero AI tokens** are consumed by the relay itself. All Claude usage runs through your existing Claude Code CLI auth (Max subscription or API key).

**Works standalone with any Claude Code CLI setup** — no other tools or plugins required. You can optionally pair it with [FlipClaw](https://github.com/bbesner/flipclaw) if you want persistent cross-session memory, but every feature below works without it.

## Features

- **Session browser** — `/sessions` lists all recent Claude Code sessions across every interface (Desktop, VS Code, Telegram) so you can pick up any thread from your phone
- **Cross-interface resume** — `/resume <n>` jumps into any session by number, ID, or saved label — even sessions started outside Telegram
- **Session labeling** — `/save <name>` labels the current session for instant recall later
- **Durable background jobs (v1.8.0+)** — `/run <prompt>` kicks off a detached subprocess that survives the relay restarting. The bot messages you when it's done, including the full response, tools used, duration, and cost. Use for tasks that exceed the 8-minute synchronous window. Manage with `/jobs`, `/job <id>`, `/cancel <id>`.
- **Live status while Claude works (v1.7.0+)** — instead of a silent typing dot, you see a single message that updates in place as Claude works: **🤔 Thinking…** → **📖 Using Read /path/to/file.js** → **📝 Replying…** → the final answer. Tool-heavy tasks feel dramatically more responsive on a phone. Opt out with `STREAMING=false` in `.env` to fall back to the v1.6.0 synchronous path.
- **Session continuity** — conversations persist across messages using `--resume`, and as of v1.6.0 the relay performs a resume preflight and never silently swaps a broken session for a fresh one — if your session can't be resumed, you get an explicit warning with `/new` and `/sessions` recovery options
- **In-flight cancellation (v1.6.0+)** — `/interrupt` (or `/stop`, `/cancel`) kills the running Claude subprocess without touching your session, so you can abort a task that's gone off the rails
- **Cost visibility (v1.6.0+)** — `/cost` and the enriched `/info` surface per-turn and cumulative `total_cost_usd` straight from Claude's JSON output
- **Native command menu** — all commands auto-register with Telegram on startup, so tapping `/` in the chat shows a full autocomplete dropdown and populates the Menu button
- **Group chat support** — add the bot to groups alongside other bots; responds to @mentions
- **Message queuing** — sequential per-chat processing prevents race conditions
- **Markdown formatting with syntax highlighting (v1.4.0+)** — Claude's output is converted to Telegram-safe HTML and fenced code blocks (` ```python `, ` ```bash `, etc) get native syntax coloring in the Telegram clients that support it
- **Inline keyboard buttons (v1.4.0+)** — every Claude response ends with tappable `[+ New]  [💾 Save]  [ℹ Info]` buttons so you can clear/label/inspect the current session in one tap, no typing required. Disable with `INLINE_KEYBOARDS=false`.
- **Session export (v1.4.0+)** — `/export` renders the current session as a clean Markdown document and sends it back as a Telegram file attachment, perfect for sharing or archiving
- **OpenClaw memory search (v1.4.0+, optional)** — if OpenClaw is installed, `/memory <query>` searches your memory directly via `openclaw memory search` with zero AI tokens. Auto-detected from `~/.openclaw/openclaw.json` or a custom `OPENCLAW_CONFIG_PATH`. Standalone users never see this command.
- **Long message chunking** — responses over 4000 chars are split at paragraph boundaries
- **Media support** — send photos, PDFs, documents; Claude analyzes them and sends files back
- **Server management commands** — `/status`, `/logs`, `/restart`, `/deploy` are forwarded to Claude Code
- **Memory integration (optional)** — Claude Code's hooks fire normally, so sessions flow into any hook-based memory pipeline you already use (e.g. FlipClaw) — no extra setup needed
- **Outbound notifications (v1.3.0+)** — `scripts/send-message.sh` and `lib/send-message.js` let cron jobs, deploy hooks, background scripts, and Claude Code agents push notifications to your Telegram. The installer creates a `tg-send` symlink in your working directory for easy calls.

## Prerequisites

- Server with [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js 18+
- PM2 (`npm install -g pm2`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

> If you use the bootstrap installer (v1.5.0+, see below), it will detect and install any of these prerequisites for you automatically — the only thing you need to do by hand is talk to BotFather to create the bot (since that's inherently a phone step).

## Quick Start

### 1. Create a Telegram bot

1. Open Telegram, find [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Choose a name and username (must end in `bot`)
4. Save the token

### 2. Install

**Recommended (v1.5.0+): bootstrap installer.** If you have Claude Code CLI installed, paste this one line into Claude Code and it will walk you through the whole install — detecting what's already on your system, installing any missing prerequisites, and running the installer with the right flags:

```
Read and follow https://raw.githubusercontent.com/bbesner/claude-telegram-relay/main/BOOTSTRAP.md
```

**Manual install:** if you'd rather run it yourself, or you don't have Claude Code CLI yet:

```bash
git clone https://github.com/bbesner/claude-telegram-relay.git
cd claude-telegram-relay
bash install.sh
```

The installer will prompt for your bot token, allowed user IDs, and working directory.

Or pass everything via flags:

```bash
bash install.sh \
  --token "YOUR_BOT_TOKEN" \
  --users "YOUR_TELEGRAM_USER_ID" \
  --working-dir "$HOME"
```

### 3. Test

Open Telegram and send a message to your bot.

Tip: tap the `/` button (or the Menu button next to the chat input) to see every command with a description. The relay registers its full command menu with Telegram automatically on startup.

## Configuration

All configuration lives in `.env` (created by the installer):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from @BotFather |
| `ALLOWED_USER_IDS` | Yes | — | Comma-separated Telegram user IDs |
| `CLAUDE_PATH` | No | auto-detect | Path to `claude` binary |
| `WORKING_DIR` | No | `$HOME` | Working directory for Claude CLI (determines which `CLAUDE.md` is loaded) |
| `CLAUDE_MODEL` | No | default | Model override (e.g., `sonnet`, `opus`) |
| `CLAUDE_TIMEOUT_MS` | No | `120000` | Per-message timeout in milliseconds |
| `MESSAGE_QUEUE_MAX` | No | `5` | Max queued messages per user |
| `GROUP_MODE` | No | `mention` | Group behavior: `mention` (respond to @bot only) or `all` |
| `SEND_STARTUP_MESSAGE` | No | `false` | Notify users when bot starts |
| `LOG_LEVEL` | No | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `INLINE_KEYBOARDS` | No | `true` | v1.4.0+: show `[+ New] [💾 Save] [ℹ Info]` buttons under responses. Set to `false` to disable. |
| `OPENCLAW_CONFIG_PATH` | No | `~/.openclaw/openclaw.json` | v1.4.0+: path to OpenClaw config for the `/memory` command. Leave empty to auto-detect; `/memory` is silently disabled if no OpenClaw is found. |
| `OPENCLAW_BIN` | No | `openclaw` (on PATH) | v1.4.0+: path to the `openclaw` binary |
| `OPENCLAW_CWD` | No | config parent dir | v1.4.0+: working directory for the openclaw subprocess |
| `OPENCLAW_SEARCH_TIMEOUT_MS` | No | `90000` | v1.4.0+: timeout (ms) for `/memory` searches. Cold queries on a large semantic index can take 30–90s the first time. |
| `DEFAULT_CHAT_ID` | No | first `ALLOWED_USER_IDS` entry | v1.3.0+: default recipient for outbound `tg-send` / `sendMessage` calls |
| `UPDATE_CHECK` | No | `true` | v1.5.0+: notify the admin on Telegram when a new release is published on GitHub. Checks once at startup, then every 24h. Never auto-upgrades — just sends a message with release notes and a link. Set to `false` to disable. |
| `STREAMING` | No | `true` | v1.7.0+: show live status (🤔 Thinking → 📖 Using Read → 📝 Replying) by editing a single Telegram message as Claude works. Set to `false` to fall back to the v1.6.0 synchronous path. |
| `JOB_TIMEOUT_MS` | No | `3600000` | v1.8.0+: wall-clock cap for background jobs started via `/run`. Default 1 hour. |

Find your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).

## Commands

All commands below are also available as a native Telegram autocomplete: tap `/` in the chat input, or tap the Menu button next to the input field. The relay publishes its command list to Telegram on every startup via `setMyCommands`, so there's nothing to configure in BotFather.

### Bot Commands (instant, no AI tokens used)

| Command | Description |
|---------|-------------|
| `/sessions` | List all recent Claude Code sessions across all interfaces |
| `/resume <n>` | Resume session #n from the last `/sessions` list |
| `/resume <session-id>` | Resume by full or partial session ID |
| `/resume <label>` | Resume by saved label |
| `/save <name>` | Label the current session (e.g. `/save sck-migration`) |
| `/start` | Welcome message and command list |
| `/new` | Clear session, start a fresh conversation |
| `/info` | v1.6.0+: Session ID, status (🟢/🟡), last-error, last-resume-failure, cost, uptime |
| `/cost` | v1.6.0+: Last-turn and cumulative cost for the current session |
| `/interrupt` | v1.6.0+: Cancel the in-flight Claude request. Aliases: `/stop`, `/cancel` |
| `/run <prompt>` | v1.8.0+: Start a durable background job that survives long-running tasks and the relay restarting. Delivers the result when done. |
| `/jobs` | v1.8.0+: List recent background jobs for this chat |
| `/job <id>` | v1.8.0+: Full details for one background job |
| `/cancel <id>` | v1.8.0+: Cancel a running background job (SIGTERM) |
| `/export` | v1.4.0+: Dump the current session as a Markdown file and send it as a document |
| `/model [name]` | Show or set model override |
| `/help` | List all commands |

### Optional: OpenClaw Memory Search (v1.4.0+)

Only appears when an OpenClaw installation is auto-detected (see `OPENCLAW_CONFIG_PATH`). Standalone Claude Code users never see this command.

| Command | Description |
|---------|-------------|
| `/memory <query>` | Run `openclaw memory search` directly and return the top 5 results with scores. Zero AI tokens consumed. |

### Server Commands (forwarded to Claude Code)

These commands are passed to Claude Code as prompts. Claude executes them on the server and returns the results.

| Command | Description |
|---------|-------------|
| `/status` | Full server status — PM2 services, disk usage, memory |
| `/logs [service]` | Show recent logs for a PM2 service (e.g., `/logs myapp`) |
| `/restart [service]` | Restart a PM2 service (e.g., `/restart myapp`) |
| `/deploy [site]` | Deploy a site via SSH (e.g., `/deploy mysite`) |

If you omit the argument (e.g., just `/logs`), Claude will ask which service you mean.

Adding custom pass-through commands is simple — edit the `PASSTHROUGH_COMMANDS` object in `lib/commands.js`.

## Media Support

### Sending files to Claude
Send photos, screenshots, PDFs, documents, or videos directly in the chat. Claude will download and analyze them. Include a caption to guide the analysis.

### Receiving files from Claude
When Claude creates or writes files on the server, they are automatically detected and sent back to you as Telegram photos or documents.

## Group Chat Usage

Add the bot to any Telegram group. By default (`GROUP_MODE=mention`), the bot only responds to:
- Messages that @mention the bot
- Direct replies to the bot's messages

Set `GROUP_MODE=all` to respond to every message from authorized users.

Each group gets its own independent Claude session. You can have the bot in a group alongside other bots — they won't interfere with each other.

## Session Management

- Each chat (DM or group) maintains its own Claude Code session
- Sessions persist across bot restarts (stored in `~/.claude-telegram-relay/sessions.json`)
- Use `/new` to start a fresh conversation
- If a session can't be resumed (transcript missing, Claude returned a resume error), the bot **does not** silently swap to a fresh one. You get an explicit warning with `/new` or `/sessions` recovery options (v1.6.0+)
- Per-session health shows up in `/info`: 🟢 active / 🟡 degraded, last success time, last error, last resume-failure time, and any previous session that was replaced

### Cross-Interface Session Sharing

Since all Claude Code interfaces (Desktop app, VS Code, Telegram) SSH into the same server and share the same `~/.claude/projects/` directory, **all sessions are visible from Telegram regardless of which interface started them**.

```
/sessions
```
```
Recent Claude Code Sessions

1. 2h ago  ~/ari 📱
   0844dd6e  1542KB
   Hi this is brad

2. 4h ago  ~
   84be4f10  4732KB
   You are working inside Ari's workspace…

3. yesterday  ~/sarah
   21debf64  783KB
   I'd like to review the Twilio ConversationRelay config…

📱 = started via Telegram
Resume: /resume 3  or  /resume <full-id>
```

```
/resume 3
```
→ Next message continues the Twilio session.

To hand off from Telegram to Desktop: note the session ID from `/info` in Telegram, then use `claude --resume <id>` in the Desktop app.

To label a session for easy recall:
```
/save twilio-fix
```
Later:
```
/resume twilio-fix
```

## Memory Integration (optional)

The relay invokes `claude -p` as a normal subprocess, so any Claude Code hook you've already set up fires exactly the same way for Telegram messages as it does for Desktop or VS Code sessions:

- **Stop hook** fires per-turn (useful for fact extraction)
- **SessionEnd hook** fires when the session ends (useful for full transcript capture)
- Session transcripts land in `~/.claude/projects/` like any other Claude Code session — which is also what makes `/sessions` work

No additional configuration needed — if you have hooks, they just work. If you don't, the relay still works fine on its own; you just won't get any cross-session memory.

If you want a drop-in hook-based memory system, [FlipClaw](https://github.com/bbesner/flipclaw) is one option, but any hook framework (or your own custom hook scripts) will work equally well.

## Sending Outbound Messages (v1.3.0+)

The relay's primary job is bridging messages **into** Claude Code, but starting in v1.3.0 it also ships an outbound message helper that lets any process on the server send a Telegram notification through your bot. Useful for cron jobs, deploy hooks, long-running background tasks, and Claude Code agents that want to notify you when something is done.

The same bot token used by the relay is reused — no extra configuration needed.

### Shell usage

```bash
# Direct message (uses default chat ID from .env)
bash ~/claude-telegram-relay/scripts/send-message.sh "Build 42 succeeded"

# After install, a convenience symlink is created in your working directory
bash ~/scripts/tg-send "Deployment complete"

# From a file
bash ~/scripts/tg-send --file /tmp/deploy-summary.txt

# From stdin (great for piping logs or generated reports)
git log --oneline -10 | bash ~/scripts/tg-send --stdin --title "Recent commits"

# Send to a specific chat ID (overrides the default)
bash ~/scripts/tg-send --chat-id 123456789 "Direct to a specific user"

# With Markdown formatting
bash ~/scripts/tg-send --parse-mode Markdown "*Build complete* — _42 tests passed_"
```

Long messages (over ~3800 characters) are automatically split at paragraph or line boundaries and sent as multiple sequential `[1/N]`-prefixed messages.

### Node.js usage

For projects that already have access to the relay's `lib/`, the same functionality is available as a module:

```javascript
const { sendMessage } = require('./lib/send-message');

// Simple
await sendMessage('Hello from Node');

// With options
const messageIds = await sendMessage('Build #42 finished', {
  title: '✅ Deploy complete',
  parseMode: 'Markdown',
  chatId: 123456789, // optional, defaults to first ALLOWED_USER_IDS entry
});

console.log(`Sent message_ids: ${messageIds.join(', ')}`);
```

The `sendMessage` function returns an array of Telegram `message_id`s (one per chunk for long messages). It throws on failure with a descriptive error.

### Default chat ID resolution

The script picks the recipient in this order:

1. `--chat-id` flag (shell) or `options.chatId` (Node)
2. `DEFAULT_CHAT_ID` environment variable (set in `.env` or your shell)
3. **First ID** in the comma-separated `ALLOWED_USER_IDS` list (default for single-user setups)

If none of those resolve to a valid numeric ID, the script exits with an error.

### Common patterns

**Cron job notifications:**
```bash
0 4 * * * /path/to/backup.sh && bash ~/scripts/tg-send "Nightly backup OK" || bash ~/scripts/tg-send "Nightly backup FAILED"
```

**Build/deploy hooks:**
```bash
# In .git/hooks/post-receive or your CI script
bash ~/scripts/tg-send --title "Deployed" "$(git log -1 --format='%h %s')"
```

**Pipe a generated report:**
```bash
my-status-script.sh | bash ~/scripts/tg-send --stdin --title "Daily status"
```

**From a Claude Code session (when explicitly asked):**
```bash
# Claude Code agents can call this directly when the user requests a notification
bash ~/scripts/tg-send "Done with the migration. 47 records updated, 0 errors."
```

### Security note

Anyone who can execute `send-message.sh` on your server can send messages from your bot. The script reads the bot token from your `.env` file (which is gitignored). Don't expose this script over the network, and don't share `.env` contents. The default chat ID restriction means messages only go to allowed users, but a malicious caller with `--chat-id` could send to any user ID — so treat the script the same way you'd treat the `.env` file itself: server-local, owner-readable.

## Managing the Service

```bash
# View logs
pm2 logs claude-telegram-relay

# Restart
pm2 restart claude-telegram-relay

# Stop
pm2 stop claude-telegram-relay

# Monitor
pm2 monit
```

## Architecture

```
┌─────────────┐     ┌──────────────────────┐     ┌───────────────┐
│  Telegram    │────▶│  claude-telegram-    │────▶│  claude -p    │
│  (polling)   │◀────│  relay (Node.js)     │◀────│  (subprocess) │
└─────────────┘     └──────────────────────┘     └───────────────┘
                              │
                     ┌────────┴────────┐
                     │  sessions.json  │
                     │  (session state)│
                     └─────────────────┘
```

- **Polling mode** — no open ports, no webhook, no attack surface
- **Stdin piping** — prompts are written to claude's stdin, avoiding shell escaping issues
- **Per-chat queues** — messages are processed sequentially per chat, concurrently across chats
- **HTML formatting** — Markdown is converted to Telegram HTML for reliable rendering

## Security

- Only Telegram users in `ALLOWED_USER_IDS` can interact — all others are silently ignored
- Bot token and config live in `.env` (gitignored)
- Polling mode means no exposed HTTP endpoints
- Claude CLI uses your existing auth — no API keys stored in the relay

## Troubleshooting

**Bot doesn't respond:**
- Check logs: `pm2 logs claude-telegram-relay`
- Verify your Telegram user ID matches `ALLOWED_USER_IDS`
- Test Claude CLI directly: `echo "hello" | claude -p`

**"Claude CLI not found" error:**
- Set `CLAUDE_PATH` in `.env` to the full path (e.g., `/home/ubuntu/.npm-global/bin/claude`)

**Long responses cut off:**
- Responses are automatically chunked at 4000 chars. If chunking breaks formatting, this is a known limitation of Telegram's HTML parser.

**Session seems stuck:**
- Send `/new` to clear the session and start fresh

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT -- see [LICENSE](LICENSE).

---

*Built by [Brad Besner](https://github.com/bbesner) at [Ultraweb Labs](https://ultraweblabs.com). If this saves you time, give it a star — https://github.com/bbesner/claude-telegram-relay*
