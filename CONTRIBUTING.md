# Contributing

Thanks for wanting to help. `ember` is a small, opinionated tool — issues and
pull requests are welcome.

## Getting started

```bash
git clone https://github.com/ozandogrultan/opencode-ember.git
cd opencode-ember
bun install
```

There is no build step. `ember.ts` is the whole plugin, `gain.ts` is the
`ember gain` reporting CLI, `test/` holds the bun tests, and
`scripts/changelog.sh` owns the release bookkeeping. `opencode` loads the TS
source directly.

## Before you open a PR

Run the full check suite and make sure it passes:

```bash
bun run test         # bun test plus the changelog-tooling tests
bun run typecheck    # tsc --noEmit
bun run lint:sh      # bash -n on every script
```

CI runs the same checks plus ShellCheck on the scripts.

## Guidelines

- Read [AGENTS.md](AGENTS.md) first. It documents the layout and the hard-won
  rules — in particular, changes that regress them will not be merged.
- Keep PRs focused. One concern per PR, with a clear description of the *why*.
- Match the surrounding style. TypeScript is formatted by hand; no formatter is
  enforced.
- A warm ping must only **append**: reuse the session's exact model, agent,
  tools and system prompt, and never edit, clear, compact or cold-rewrite the
  session.
- Never ping a cache that has already lapsed; stop the heartbeat instead.
- Dollar figures are hard-coded estimates. An unpriced model must read `$0.00`
  and leave the raw counters accurate.
- New behaviour should come with a test in `test/` where practical.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional scope>): <description>
```

| Type | Use for | Version impact |
| --- | --- | --- |
| `feat` | a new feature | minor |
| `fix` | a bug fix | patch |
| `perf` | a performance improvement | patch |
| `docs` | documentation only | none |
| `refactor` | behaviour-preserving change | none |
| `test` | tests only | none |
| `build` | build system or dependencies | none |
| `ci` | CI configuration | none |
| `chore` | other maintenance | none |

- Write the subject in the imperative mood, lower case, no trailing period.
- Add a body when the *why* is not obvious from the subject.
- Flag incompatible changes with `!` after the type/scope (`feat!:`) and/or a
  `BREAKING CHANGE:` footer; that maps to a major version.

Examples:

```text
feat(guard): refuse cold sends over the context floor
fix(ping): stop after two zero-activity readbacks
docs: document the pricing caveats
feat!: drop support for opencode < 1.18
```

This is enforced locally by Git hooks that `bun install` installs (via husky):

- `commit-msg` runs commitlint over your message.
- `pre-commit` runs `bun run lint:sh`, `bun run typecheck`, and `bun run test`.

Bypass a hook for one commit with `git commit --no-verify` (or `HUSKY=0`), but
CI lints the commits in a pull request regardless.

## Releases

Releases are cut from the **Release** workflow (`workflow_dispatch`), which asks
for a `patch`, `minor` or `major` bump and then:

1. bumps `package.json` to the next version,
2. promotes `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) to
   `## [X.Y.Z] - <date>`, opens a fresh `[Unreleased]`, and moves the compare
   links,
3. commits and tags `vX.Y.Z`, publishes to npm with provenance, and creates the
   GitHub release with the promoted section as its body.

So write changelog entries as you go instead of at release time: add bullets to
`[Unreleased]`, grouped as Keep a Changelog's `Added` / `Changed` / `Fixed` /
`Removed` / `Security`. Cutting a release with an empty `[Unreleased]` fails
before anything is pushed or published, because that section *is* the release
body. (Pushing a tag by hand still works: with no matching section the release
falls back to GitHub-generated notes and warns.)

`scripts/changelog.sh` performs the same steps locally:

```bash
scripts/changelog.sh draft          # classify commits since the last tag (prints only)
scripts/changelog.sh draft --write  # fill an empty [Unreleased]; --force overwrites
scripts/changelog.sh promote 0.2.0  # promote, date and relink [Unreleased]
scripts/changelog.sh notes 0.2.0    # the release-notes body for a version
scripts/changelog.sh check          # structure: headings and compare links
```

`bun run test:changelog` covers the tooling, and `check` also runs in CI: every
released heading needs its link definition and `[Unreleased]` must point at
`...HEAD`. See [RELEASING.md](RELEASING.md) for the npm trusted-publisher setup.

## Reporting bugs and requesting features

Use the issue templates. For bugs, include your OS, `opencode` version, and the
steps to reproduce.

## Security

Please do not file public issues for security problems. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
