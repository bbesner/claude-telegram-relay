# claude-telegram-relay

Talk to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from your phone. Send a Telegram message, get a full Claude Code response back — using your existing Max subscription with zero per-token relay cost.

```
You (Telegram) → Bot (this relay) → claude -p → response → Bot → You
```

The relay is a pure message shuttle — **zero AI tokens** are consumed by the relay itself. All Claude usage runs through your existing Claude Code CLI auth (Max subscription or API key).

Pair with [FlipClaw](https://github.com/bbesner/flipclaw) for persistent memory across all your Claude Code sessions -- including conversations that come through this relay.

## Features

- **Session browser** — `/sessions` lists all recent Claude Code sessions across every interface (Desktop, VS Code, Telegram) so you can pick up any thread from your phone
- **Cross-interface resume** — `/resume <n>` jumps into any session by number, ID, or saved label — even sessions started outside Telegram
- **Session labeling** — `/save <name>` labels the current session for instant recall later
- **Session continuity** — conversations persist across messages using `--resume`
- **Group chat support** — add the bot to groups alongside other bots; responds to @mentions
- **Message queuing** — sequential per-chat processing prevents race conditions
- **Markdown formatting** — Claude's output is converted to Telegram-safe HTML
- **Long message chunking** — responses over 4000 chars are split at paragraph boundaries
- **Media support** — send photos, PDFs, documents; Claude analyzes them and sends files back
- **Server management commands** — `/status`, `/logs`, `/restart`, `/deploy` are forwarded to Claude Code
- **Memory integration** — Claude Code's hooks fire normally, so sessions flow into your existing memory pipeline

## Prerequisites

- Server with [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js 18+
- PM2 (`npm install -g pm2`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Quick Start

### 1. Create a Telegram bot

1. Open Telegram, find [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Choose a name and username (must end in `bot`)
4. Save the token

### 2. Install

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

Find your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot).

## Commands

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
| `/info` | Show session ID, message count, uptime |
| `/model [name]` | Show or set model override |
| `/help` | List all commands |

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
- If a session becomes corrupted, the bot automatically starts a fresh one

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

## Memory Integration

If you use [FlipClaw](https://github.com/bbesner/flipclaw) or any other Claude Code hook-based memory system, your Telegram conversations will be captured automatically. The relay invokes `claude -p` as a normal subprocess, so:

- **Stop hook** fires per-turn for fact extraction
- **SessionEnd hook** fires when the session ends for full transcript capture
- Sessions appear in `~/.claude/projects/` like any other Claude Code session

No additional configuration needed — it just works.

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

Built by [Brad Besner](https://github.com/bbesner) at Ultraweb Labs.
