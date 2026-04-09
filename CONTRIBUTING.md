# Contributing to claude-telegram-relay

Thanks for your interest in contributing! This project is a lightweight relay between Telegram and Claude Code CLI, and contributions that keep it simple and focused are welcome.

## Getting Started

1. Fork the repo and clone your fork
2. Run `npm install` to install dependencies
3. Copy `config/env.example` to `.env` and fill in your bot token and Telegram user ID
4. Run `npm run dev` for debug-level logging during development

## Guidelines

- **Keep it simple.** The relay is a message shuttle, not a framework. Resist adding abstractions unless they solve a clear problem.
- **No new dependencies** without discussion. The project intentionally has a minimal dependency footprint (just `dotenv` and `node-telegram-bot-api`).
- **Test manually.** There is no automated test suite yet. Before submitting a PR, verify your change works end-to-end with a real Telegram bot.
- **One concern per PR.** Small, focused pull requests are easier to review and merge.

## What to Contribute

Good first contributions:
- Bug fixes (especially edge cases in message formatting or session handling)
- Documentation improvements
- Support for additional media types
- Better error messages

Larger changes (please open an issue first):
- New pass-through commands
- Alternative transport modes (webhooks, etc.)
- Multi-user session isolation changes

## Code Style

- Plain Node.js (no TypeScript, no transpilation)
- CommonJS `require` (no ES modules)
- Consistent with existing code formatting
- Structured JSON logging via `lib/logger.js`

## Reporting Issues

When filing a bug report, include:
- Node.js version (`node -v`)
- Claude CLI version (`claude --version`)
- Relevant log output (`pm2 logs claude-telegram-relay`)
- Steps to reproduce

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
