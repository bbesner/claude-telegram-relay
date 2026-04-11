<!--
Thanks for contributing! Please fill out this template so reviewers have everything they need to evaluate the change.

CONTRIBUTING.md has the full guidelines — the short version:
  - One concern per PR
  - Tests accompany behavior changes in lib/
  - No new runtime dependencies without discussion
-->

## Summary

<!-- 1-3 sentences describing what this PR does and why. Focus on "why" — reviewers can read the diff for "what". -->

## Changes

<!-- Bulleted list of the meaningful changes. Skip formatting/whitespace-only edits. -->

-
-
-

## Test plan

<!-- Check everything that applies. Reviewers will look at this to decide confidence. -->

- [ ] `npm test` passes locally (`X / X suites, Y assertions`)
- [ ] Added or updated tests for new behavior in `lib/`
- [ ] Tested end-to-end against a real Telegram bot — describe the scenario:
  <!-- e.g. "sent /sessions, resumed session 3, verified the response" -->
- [ ] No new runtime dependencies
- [ ] If this touches `config/env.example`, the README Configuration table is also updated
- [ ] If this adds or renames a user-visible command, the `/help` and `/start` output is updated and `bot.js`'s `BOT_COMMANDS` array includes it for the native Telegram menu

## Screenshots / session excerpts

<!-- Optional but helpful for UI-visible changes (formatting, inline keyboards, /export output, etc.) -->

## Related issues

<!-- Closes #N, refs #N, etc. -->
