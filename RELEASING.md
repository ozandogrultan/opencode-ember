# Releasing

[`.github/workflows/release.yml`](.github/workflows/release.yml) does the whole
job: run tests, publish to npm with provenance, and create the GitHub release.
There are two ways to trigger it.

Development uses [bun](https://bun.sh) (`bun install`, `bun run test`). Publishing
still uses the npm CLI: npm trusted publishing (OIDC) and provenance
attestations are only supported through `npm publish`, so `bun publish` is not
used here.

## One-click (recommended)

From the Actions tab (**Release → Run workflow**) or:

```bash
gh workflow run release.yml -f bump=patch   # or minor / major
```

That workflow checks out `main`, bumps the version, promotes the `[Unreleased]`
section, commits and tags it, pushes, publishes to npm, and cuts the GitHub
release with the promoted notes.

Do this from a green `main` — it releases whatever is there. Keep
[CHANGELOG.md](CHANGELOG.md) curated under `[Unreleased]`: the workflow refuses
to release an empty section.

## From a tag push

If you prefer to bump locally, promote the changelog yourself first:

```bash
bash scripts/changelog.sh promote 0.2.0   # [Unreleased] -> [0.2.0] - <today>
npm version minor                          # patch / minor / major per the commit types
git push --follow-tags                     # the tag push triggers the same release workflow
```

`prepublishOnly` runs the tests and typecheck again before uploading.

## Before you release

Pick the bump from [Conventional Commits](https://www.conventionalcommits.org/)
since the last release — the highest impact wins: `feat` → minor,
`fix`/`perf` → patch, `!`/`BREAKING CHANGE` → major. `scripts/changelog.sh draft`
can seed entries from the commit log.

## One-time setup

npm uses [trusted publishing][trusted], so no token is stored in the repo. On
npmjs.com, under `opencode-ember` → Settings → Trusted Publishers, the GitHub
Actions publisher must point at:

- owner: `ozandogrultan`
- repository: `opencode-ember`
- workflow filename: `release.yml`

Renaming that workflow file breaks publishing; update the npm setting too. The
first releases (0.1.0 and 0.2.0) predate this setup and were published with the
npm CLI directly; configure the publisher above so later releases go through the
workflow.

[trusted]: https://docs.npmjs.com/trusted-publishers

## Verifying

- npm: `npm view opencode-ember version` and
  `npm view opencode-ember dist.attestations` (provenance present).
- GitHub: a release exists for the tag, with the changelog notes.

## Manual fallback

Only if CI is unavailable:

```bash
npm login
npm publish --access public
```

Manual publishes do not get provenance attestations.
