# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ozandogrultan/opencode-ember/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ozandogrultan/opencode-ember/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ozandogrultan/opencode-ember/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ozandogrultan/opencode-ember/releases/tag/v0.1.0
