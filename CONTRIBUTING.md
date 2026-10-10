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

Also run `bash scripts/changelog.sh check`. CI checks ShellCheck errors,
the publishable tarball, and commit messages in addition to the tests and typecheck.

## Guidelines

- Read [AGENTS.md](AGENTS.md) first. It documents the layout and the hard-won
  rules — in particular, changes that regress them will not be merged.
- Keep PRs focused. One concern per PR, with a clear description of the *why*.
- Match the surrounding style. TypeScript is formatted by hand; no formatter is
  enforced.
- Keep background warming fail-closed: never fork, prompt, delete, or append
  to a session, mutate provider config, or wrap provider `options.fetch`.
  The current timer stops without issuing background provider requests.
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

Fix failing checks before committing; do not bypass the hooks. CI also lints
the commits in a pull request.

## Releases

Releases run on `v*` tag pushes or from the **Release** workflow
(`workflow_dispatch`), which asks
for a `patch`, `minor` or `major` bump and then:

1. bumps `package.json` to the next version,
2. writes a dated section and compare link in [CHANGELOG.md](CHANGELOG.md)
   from notable Conventional Commits since the last tag,
3. commits and tags `vX.Y.Z`, publishes to npm with provenance, and creates the
   GitHub release with the new section as its body.

Write Conventional Commits for notable changes. A release with no notable
commits since the previous tag is a no-op. A tag without a matching section
uses GitHub-generated release notes. Tag pushes skip npm publishing when the
version already exists on the registry, but still create or update the GitHub release.

`scripts/changelog.sh` manages changelog text locally; it does not bump
`package.json`, commit, tag, push, or publish:

```bash
scripts/changelog.sh draft          # classify commits since the last tag (prints only)
scripts/changelog.sh release 0.2.0  # write a dated section and compare link
scripts/changelog.sh notes 0.2.0    # the release-notes body for a version
scripts/changelog.sh notes          # the latest released version
scripts/changelog.sh check          # structure: headings and compare links
```

`bun run test:changelog` covers the tooling, and `check` also runs in CI: every
released heading needs its link definition. See [RELEASING.md](RELEASING.md)
for the npm trusted-publisher setup.

## Reporting bugs and requesting features

Use the issue templates. For bugs, include your OS, `opencode` version, and the
steps to reproduce.

## Security

Please do not file public issues for security problems. See
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
