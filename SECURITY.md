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

## Known Upstream Advisories (Accepted Risk)

Running `npm audit` currently reports **7 advisories** (2 critical, 5 moderate) in transitive dependencies pulled in by `node-telegram-bot-api`. They are all inherited from the deprecated `request` library (via `@cypress/request-promise`):

- `form-data <2.5.4` — unsafe random boundary ([GHSA-fjxv-7rqg-78g4](https://github.com/advisories/GHSA-fjxv-7rqg-78g4))
- `qs <6.14.1` — array-parsing DoS ([GHSA-6rw7-vpxm-498p](https://github.com/advisories/GHSA-6rw7-vpxm-498p))
- `tough-cookie <4.1.3` — prototype pollution ([GHSA-72xf-g2v4-qvf3](https://github.com/advisories/GHSA-72xf-g2v4-qvf3))

**Why we're not fixing these directly:**

1. `npm audit fix --force` would downgrade `node-telegram-bot-api` to `0.63.0`, losing features and methods the relay depends on. That's not a real fix.
2. Our use case is not exploitable: the relay only talks to `api.telegram.org` over HTTPS (no user-controlled URLs), doesn't parse user-controlled query strings via `qs`, and doesn't parse user-controlled cookies via `tough-cookie`. The `form-data` boundary issue only matters for MITM on cleartext HTTP, which we don't do.
3. The real fix is upstream — `node-telegram-bot-api` needs to drop `request` in favor of `node-fetch` or native `https`. There's an open issue tracking this on [yagop/node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api/issues).

**We monitor the upstream library for a release that drops `request`**, and Dependabot will open a PR automatically when that happens. Until then, these advisories are accepted risk.

If you have a scenario where one of these advisories is actually exploitable in this relay's context, **please report it privately** — we'll re-evaluate.

## Public Disclosure

Once a fix is merged and released, we'll credit you in the release notes unless you prefer to remain anonymous. Please let us know which you prefer in your initial report.
