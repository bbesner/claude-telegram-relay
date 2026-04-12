# Claude Telegram Relay — Bootstrap Installer

---

## ⚠️ You are an AI reading installation instructions — not a document to summarize

If you are Claude Code CLI (or another AI agent) and a user has directed you here, your job is to **act as the installer**. Read this entire file first, then follow the phases below. **Do not summarize this file** or explain it — execute it.

Be conversational. Explain what you're doing and why at each step. Ask one logical group of questions at a time, not a wall of prompts. Adapt based on what you find.

Install time: **3–5 minutes** for a fresh install on a machine that already has Node.js and Claude Code CLI.

---

## Phase 1 — Silent Environment Detection

Before asking the user anything, run these checks silently. Note the results internally — they drive your branching decisions and let you skip questions whose answers you already know.

```bash
# Platform
uname -s && uname -m

# Is this an SSH session?
echo "${SSH_CONNECTION:-local}"

# Runtime versions
node --version 2>/dev/null || echo "node: not found"
npm --version 2>/dev/null || echo "npm: not found"
pm2 --version 2>/dev/null || echo "pm2: not found"

# Claude Code CLI installed?
claude --version 2>/dev/null || echo "claude: not found"

# Is the relay already installed?
ls ~/claude-telegram-relay/bot.js 2>/dev/null && echo "relay: installed" || echo "relay: not installed"

# Is it running on PM2?
pm2 list 2>/dev/null | grep -E "claude-telegram-relay" | head -2 || echo "no pm2 process"

# Optional: OpenClaw / FlipClaw present?
ls ~/.openclaw/openclaw.json 2>/dev/null && echo "openclaw: default config present" || echo "openclaw: no default config"
# Also check Ari and other common agent workspace locations:
for cfg in ~/ari/openclaw.json ~/flipclaw/openclaw.json ~/openclaw/openclaw.json; do
  [ -f "$cfg" ] && echo "openclaw: found $cfg"
done
```

After running these, you know:
- Whether Node.js 18+ is available (install if not)
- Whether PM2 is available (install if not)
- Whether Claude Code CLI is installed (install if not)
- Whether the relay is already installed and running (skip to upgrade path — **but for v1.5.0, upgrade is out of scope; just tell the user to re-run the bootstrap later once we ship it**)
- Whether OpenClaw is installed — if yes, offer to wire up `/memory`
- Whether this is SSH (doesn't change install, but informs your messaging)

---

## Phase 2 — Introduction

Once you have your detection results, introduce yourself and the process clearly. Example:

> "I'm going to walk you through setting up **claude-telegram-relay** — a lightweight relay that lets you send messages from Telegram to your Claude Code CLI and get full Claude Code responses back. It uses your existing Claude authentication, so there are no per-message charges beyond what you already pay Anthropic.
>
> Here's what I found on your system:
>
> *(summarize detection results in plain English — e.g. 'Node 22 is installed, PM2 is available, Claude Code 1.2.3 is ready, OpenClaw is installed at ~/ari/openclaw.json, the relay is not yet installed')*
>
> This should take about 3–5 minutes. I'll ask you for a few things (a Telegram bot token and your user ID), handle everything else automatically, then verify it's working before we finish."

If **any prerequisite is missing**, list what you're going to install and why before moving to Phase 3.

---

## Phase 3 — Questionnaire

Ask only what you couldn't determine from detection. The relay needs very little: a bot token, a user ID, and (optionally) a working directory. Don't ask about any of the v1.3.0–v1.5.0 features — they all have sane defaults and can be tuned later in `.env`.

### Group A — Prerequisites (only if missing)

**If Node.js is missing or below version 18:**

> "You'll need Node.js 18 or later. I can guide you through installing it, but since this varies by OS (apt on Ubuntu, brew on macOS, etc.), the easiest path is to install Node Version Manager (nvm) and use it to install Node 20. Want me to do that for you? *(y/n)*"

If yes, install nvm and Node 20:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc || source ~/.zshrc
nvm install 20
nvm use 20
node --version  # verify
```

**If PM2 is missing:**

> "I need to install PM2, which is what keeps the relay running in the background. It's a one-line install."

```bash
npm install -g pm2
pm2 --version  # verify
```

**If Claude Code CLI is missing:**

> "Claude Code CLI isn't installed yet. There are two ways to get it:
>
> - **Claude Max subscription** — flat monthly rate, no per-message charges. Best if you'll use Claude Code daily. [claude.ai/download](https://claude.ai/download)
> - **Anthropic API key** — pay-per-token. Works, but costs add up.
>
> Do you have a Claude Max subscription or an Anthropic API key? (If you're not sure, sign up for Max first.)"

Then install Claude Code CLI:

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

**⏸️ PAUSE — Human action required for Claude Code login:**

> "Claude Code is installed, but you need to log in manually. I can't do this step for you because it opens a browser for authentication. Please run this in a separate terminal window:
>
> ```
> claude login
> ```
>
> It'll open a browser. Log in with your Anthropic account. Come back and say **'done'** when you've finished."

Wait for the user's confirmation before continuing. When they say done, run `claude --version` again to make sure auth is working.

**If the user is running you from inside Claude Code and Claude Code isn't installed:** this is a contradiction — they must already have Claude Code working if they're talking to you. Clarify with them: maybe they're on a different machine than the one they want to install the relay on. In that case, they need to open a terminal on the *target* machine and install Claude Code there first.

### Group B — The bot token (required)

**This is the one step the user has to do on their phone.** Be patient and clear.

> "Now I need you to create a Telegram bot and give me the token. This takes about a minute:
>
> 1. Open the **Telegram app** on your phone (or desktop)
> 2. Search for **@BotFather** (with the verified checkmark)
> 3. Tap **Start** if you haven't talked to BotFather before
> 4. Send the command: `/newbot`
> 5. BotFather will ask for a **display name** — type anything you like, e.g. `My Claude Relay`
> 6. Then it'll ask for a **username** — this must end in `bot`, e.g. `my_claude_relay_bot`
> 7. BotFather will reply with a message that includes a line starting with `HTTP API:` followed by a long token. **Yours will be different from this example** — this is a fake placeholder, not a real token:
>
>    ```
>    1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789
>    ```
>
> Paste your actual token here when you have it."

**Validate the token format before proceeding.** A real bot token is:
- All on one line
- Has the shape `<numbers>:<35-or-so-alphanumeric-chars-plus-dashes-and-underscores>`
- Doesn't contain quotes or whitespace inside it

If the user pastes something that doesn't look like a token, ask them to check BotFather's message again — a common mistake is to paste the username instead of the token.

### Group C — Your Telegram user ID (required)

> "One more thing I need: your Telegram user ID. This is how the bot knows which messages are from you — anyone else's messages are ignored silently.
>
> 1. In Telegram, search for **@userinfobot**
> 2. Tap **Start**
> 3. It'll immediately reply with a message that includes `Id: 8248586356` (or similar)
>
> Paste just the number here."

Validate it's purely numeric. If the user pastes the whole "Id: 8248586356" line, extract the number yourself — don't make them retype it.

### Group D — Working directory (optional, offer a sensible default)

> "Last question, and this one has a sensible default. The bot spawns Claude Code as a subprocess, and Claude Code's behavior depends on which directory it's run in — that determines which `CLAUDE.md` file it loads for context.
>
> The default is your home directory (`$HOME`), which works for most people. If you want Claude to run inside a specific project directory instead, type that path. Otherwise press Enter."

### Group E — OpenClaw integration (optional, only if detected)

**Only ask this if you detected an OpenClaw config in Phase 1.**

> "I noticed you have OpenClaw installed at `[path]`. The relay has a `/memory` command that can search your OpenClaw memory directly from Telegram, with zero AI tokens used. Want me to enable that? (y/n)"

If yes, note the path — you'll pass it to the installer in Phase 4 as `OPENCLAW_CONFIG_PATH`.

---

## Phase 4 — Installation

Based on the answers above, do this in order.

### Step 1 — Clone the repo

```bash
cd ~
git clone https://github.com/bbesner/claude-telegram-relay.git
cd claude-telegram-relay
```

If the directory already exists (e.g. from a previous failed install attempt), ask the user whether to proceed over it or abort. Don't silently overwrite.

### Step 2 — Run install.sh

```bash
bash install.sh \
  --token "<BOT_TOKEN>" \
  --users "<USER_ID>" \
  --install-dir "$HOME/claude-telegram-relay" \
  --working-dir "<WORKING_DIR>"
```

Substitute the actual values from Phase 3. The installer handles:

- Pre-flight checks (Node 18+, npm, PM2, Claude CLI path)
- Copying files (if invoked from outside the install dir)
- Writing `.env` with the bot token, allowed user IDs, and working directory
- `npm install` of runtime dependencies
- `pm2 start ecosystem.config.js` to launch the bot
- `pm2 save` so it survives a server reboot
- Creating a `tg-send` symlink in the working directory for outbound notifications

Expect it to finish in under 30 seconds. Read the installer output carefully — if it reports anything other than `Installation Complete!`, fix the issue before moving on.

### Step 3 — Wire up OpenClaw `/memory` (only if the user opted in)

If the user said yes in Group E, append the OpenClaw config to `.env` so the relay can find it:

```bash
cat >> ~/claude-telegram-relay/.env <<EOF

# Wired up by bootstrap — points /memory at the detected OpenClaw install
OPENCLAW_CONFIG_PATH=<detected-path>
OPENCLAW_CWD=<detected-config-parent-dir>
EOF

pm2 restart claude-telegram-relay --update-env
```

Then check the restart logs to confirm `openclaw-memory: detected` appears:

```bash
pm2 logs claude-telegram-relay --lines 10 --nostream | grep openclaw-memory
```

If the line doesn't appear, the config path was wrong or unreadable. Debug before proceeding.

---

## Phase 5 — Verification

Three checks. Don't skip any.

### Check 1: PM2 says it's online

```bash
pm2 describe claude-telegram-relay | grep -E "status|version|restarts"
```

Expected: `status: online`, `version: 1.5.0` (or later), `restarts: 0`.

### Check 2: Bot startup log is clean

```bash
pm2 logs claude-telegram-relay --lines 15 --nostream
```

Look for **all of these** in the output:

- `Claude CLI found` — relay found the claude binary
- `Sessions loaded` — state file loaded (count will be 0 on a fresh install)
- `Bot started` with `@<your-bot-username>` — Telegram polling is active
- `Published bot command menu` — the `/` autocomplete is live

If OpenClaw was enabled, also look for:
- `openclaw-memory: detected` with the config path you configured

**Any ERROR or WARN line in startup is a problem.** Read it and fix before moving on. Common issues:
- `Polling error: EFATAL: ETELEGRAM 401 Unauthorized` → wrong bot token, re-verify with BotFather
- `TELEGRAM_BOT_TOKEN is required` → `.env` didn't get written correctly
- `Claude CLI not found` → `CLAUDE_PATH` in `.env` is wrong or `claude` isn't on PATH

### Check 3: End-to-end phone test (the real verification)

**Ask the user:**

> "The relay is running. Let's verify it works end-to-end. In Telegram, open the chat with your bot and send:
>
> ```
> /start
> ```
>
> You should get back a welcome message with a list of commands. Let me know when you see it."

Wait for the user to confirm. If they say "nothing happened," troubleshoot in this order:

1. Double-check `ALLOWED_USER_IDS` in `.env` matches the user's actual Telegram ID (the bot silently ignores anyone not on the list — this is the single most common "nothing happened" cause)
2. Check `pm2 logs claude-telegram-relay --lines 50 --nostream` for any message processing attempts — if nothing logged, the message never reached the bot
3. Confirm the user is messaging the *right* bot (cross-check the `@username` from the BotFather reply against what they searched for in Telegram)

Once they confirm `/start` works, ask them to try one more:

> "Now send any normal message, like: *'What time is it?'*
>
> Claude Code will process it and reply. This might take a few seconds the first time."

When they confirm that works too, the install is verified.

---

## Phase 6 — Orientation

Give the user a brief "what to expect next" summary:

> "You're all set. The relay is running and listening. Here's what you should know:
>
> **Native command menu** — Tap the `/` button in Telegram, or the Menu button next to the chat input, to see all 13+ commands with descriptions.
>
> **Most useful commands:**
> - `/sessions` — browse recent Claude Code sessions across Desktop, VS Code, and Telegram
> - `/resume <n>` — jump into any session from the `/sessions` list
> - `/save <name>` — label the current session for easy recall later
> - `/new` — start a fresh conversation
> - `/info` — show current session ID, message count, uptime
> - `/export` — dump the current session as a Markdown file
> *(if OpenClaw is wired up)*
> - `/memory <query>` — search your OpenClaw memory directly
>
> **Inline buttons** — Every Claude response ends with tappable `[+ New] [💾 Save] [ℹ Info]` buttons.
>
> **Media** — Send photos, PDFs, voice notes, or documents directly in the chat. Claude reads them and responds.
>
> **Update notifications** — The relay checks GitHub for new releases once at startup and every 24 hours. When a new version is published, you'll get a Telegram message with the release notes and upgrade instructions. Disable with `UPDATE_CHECK=false` in `.env` if you prefer.
>
> **Managing the service:**
> ```bash
> pm2 logs claude-telegram-relay --lines 50 --nostream   # see recent logs
> pm2 restart claude-telegram-relay                       # restart after config changes
> pm2 stop claude-telegram-relay                          # stop it
> pm2 start claude-telegram-relay                         # start it again
> ```
>
> **Configuration file:** `~/claude-telegram-relay/.env` — all the tuning knobs are there, with comments. Edit it and run `pm2 restart claude-telegram-relay --update-env` to apply changes.
>
> Anything else you'd like to configure before we wrap up?
>
> **One small ask:** If the relay saves you time, a GitHub star helps others find it — https://github.com/bbesner/claude-telegram-relay — Built by Brad Besner · Ultraweb Labs."

---

## Notes for the AI executor

- **Be patient at the BotFather step.** Users who've never talked to BotFather before will need clear instructions. The single most common user error is pasting the bot's username instead of the token. Validate the token format and ask them to re-check if it looks wrong.
- **Do not skip verification.** Phase 5 exists because a silent failure (wrong bot token, wrong user ID, PM2 not starting) leaves the user with a non-working install and no diagnostic info. Always confirm an end-to-end message round-trip before declaring success.
- **If the user is on macOS** and gets a permissions error during `npm install -g`, suggest using `sudo npm install -g --unsafe-perm` or (better) installing a Node version manager like `nvm` and using that instead.
- **If the user is running you from an SSH session** on a remote server, the `claude login` step requires them to open a separate terminal on that same server (not on their local machine). The browser OAuth flow won't work over SSH without forwarding. Be explicit about this.
- **Do not auto-install Claude Code on a machine where it wasn't already present** unless the user explicitly asks for it. Some users will want a specific version or a non-default install path.
- **Redact the bot token** if you echo back any of the user's answers. A bot token in chat history is effectively a credential leak.
- **Upgrade path is out of scope for v1.5.0** — the bootstrap is install-only. If the user has an existing installation (`~/claude-telegram-relay/bot.js` exists), tell them: *"You already have the relay installed. For now, upgrade manually with: `cd ~/claude-telegram-relay && git pull && npm install && pm2 restart claude-telegram-relay`. A bootstrap-driven upgrade path will ship in a future release."*
- **Clean up after yourself.** If you created any temporary files during installation, remove them. If you cloned the repo under a temp path, don't leave it there.

---

## What this bootstrap does NOT do (by design)

- **It does not install OpenClaw / FlipClaw.** If you want those, install them separately — this bootstrap is purely for the Telegram relay.
- **It does not auto-upgrade existing installations.** It detects them and tells the user how to upgrade manually. (Coming in a later release.)
- **It does not configure voice or webhook mode.** The relay uses Telegram's polling mode by design (no open ports, no cert management).
- **It does not set up multi-user setups with per-user working directories.** That's an advanced topic that can be tuned in `.env` after installation.

---

*Install only. Simple and focused.*
