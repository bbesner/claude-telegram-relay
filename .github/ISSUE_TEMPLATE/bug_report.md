---
name: Bug report
about: Something isn't working as expected
title: "[bug] "
labels: bug
assignees: ''
---

## What happened

<!-- A clear, one-or-two-sentence description of the bug. -->

## What you expected to happen

<!-- What should have happened instead? -->

## Steps to reproduce

1.
2.
3.

## Environment

- **Relay version:** <!-- `cat VERSION` or the commit SHA -->
- **Node.js version:** <!-- `node -v` -->
- **Claude CLI version:** <!-- `claude --version` -->
- **OS:** <!-- e.g. Ubuntu 24.04, macOS 14, Windows 11 -->
- **Telegram client:** <!-- e.g. Android 4.8.1, iOS 10.14, Desktop 5.8 -->
- **OpenClaw / FlipClaw installed?** <!-- yes / no — affects /memory -->

## Relevant log output

<details>
<summary>PM2 logs (<code>pm2 logs claude-telegram-relay --lines 50 --nostream</code>)</summary>

```
paste logs here
```

</details>

## Additional context

<!-- Screenshots, configuration snippets (redact your bot token!), anything else that might help. -->

## Checklist

- [ ] I verified my bot token is set and `ALLOWED_USER_IDS` includes my Telegram user ID
- [ ] I restarted the service (`pm2 restart claude-telegram-relay`) and the bug still reproduces
- [ ] I searched existing issues to avoid duplicates
- [ ] I've redacted any sensitive values (tokens, user IDs, paths to private code) from logs
