# Security Policy

## Reporting a Vulnerability

If you discover a security issue in `claude-telegram-relay`, please **do not open a public GitHub issue**. Instead, report it privately by emailing:

**bbesner@techprosecurity.com**

Please include:

- A short description of the issue and its potential impact
- Steps to reproduce (or a proof-of-concept if you have one)
- The version of the relay you were testing against (`cat VERSION` or the commit SHA)
- Your Node.js version and OS, if relevant

You can expect an acknowledgement within **48 hours** and a concrete response (fix, mitigation, or timeline) within **7 days** for confirmed issues. For severe issues affecting bot tokens, authentication, or remote code execution, the response will be faster.

## Scope

This repository ships a Node.js relay that forwards messages between Telegram and a local `claude` CLI subprocess. Security-relevant areas include:

- **Bot token handling** — how `TELEGRAM_BOT_TOKEN` is loaded, logged, or exposed
- **Authorization** — how `ALLOWED_USER_IDS` is enforced and whether any command bypasses it
- **Command injection** — how user input is passed to `claude`, `openclaw`, or any other subprocess
- **Path traversal** — how session IDs, file paths, and `/export` / media-download paths are sanitized
- **Outbound messaging** — how `scripts/send-message.sh` and `lib/send-message.js` authenticate and route
- **Media handling** — how inbound photos, PDFs, documents, and voice notes are downloaded and passed to `claude`

Issues in upstream dependencies (`node-telegram-bot-api`, `dotenv`) should be reported to those projects directly, but feel free to CC us if they affect this relay's security posture.

## Out of Scope

- Denial of service via rate-limiting the bot yourself (the relay has a built-in per-chat message queue)
- Issues requiring physical access to the server
- Vulnerabilities in Claude Code CLI itself (report those to Anthropic)
- Social engineering attacks against bot operators

## Supported Versions

Only the latest release on `main` is actively supported. Older versions may not receive security fixes — if you're on a tagged release older than the latest minor version, upgrade first and confirm the issue still reproduces before reporting.

## Public Disclosure

Once a fix is merged and released, we'll credit you in the release notes unless you prefer to remain anonymous. Please let us know which you prefer in your initial report.
