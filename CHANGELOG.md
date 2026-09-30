# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-30

### Added

- **release:** Generate changelogs from released commit ranges

## [0.3.2] - 2026-09-30

### Fixed

- Mark and title warm ping fork sessions as hidden so external hook bridges do not emit turn-completion notifications
## [0.3.1] - 2026-09-30

### Fixed

- Adopt the always-on and guard settings changed by another opencode process instead of overwriting them from a stale snapshot
- Resume warming for a session armed in the shared state file when it goes idle in a process that has not seen a message for it
- Skip a ping whose timer fired after the cache tier lapsed (sleep, suspend) instead of cold-writing the fork and stopping
- Count the last reply's uncached output as expected on the first ping, so a long final answer on a small context no longer reads as a lost cache
- Stop arming and pinging subagent (child) sessions
- Serialize state-file writes with a lock so concurrent opencode processes no longer lose each other's sessions
## [0.3.0] - 2026-09-25

### Added

- Pricing for GPT-5 and Gemini models

### Fixed

- Avoid creating `.bak` backup file on install
## [0.2.0] - 2026-09-25

### Added

- Ember gain as a standalone CLI binary
- /ember gain — historical savings report with per-day impact

### Fixed

- Retry inconclusive and failed pings once instead of stopping outright

## [0.1.0] - 2026-09-24

### Added

- Keep an LLM prompt cache warm across a break: `/keepwarm` pings the session's
  own prefix over a fork, so no heartbeat enters the conversation.
- Cold guard prices a lapsed cache before you send, with `warn` and `refuse`
  modes (`/ember guard`).
- `/ember` card and the `ember gain` report show per-session warm state, cold
  writes, and a 90-day per-day impact history.
- Always-on warming for six hours by default, with per-session windows, a
  configurable TTL and ping period, and a shared state file that merges safely
  across opencode processes.

[0.4.0]: https://github.com/ozandogrultan/opencode-ember/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/ozandogrultan/opencode-ember/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/ozandogrultan/opencode-ember/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ozandogrultan/opencode-ember/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ozandogrultan/opencode-ember/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ozandogrultan/opencode-ember/releases/tag/v0.1.0
