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

That workflow checks out `main`, bumps the version, writes a section from
notable commits since the previous tag, commits and tags it, pushes, publishes
to npm, and cuts the GitHub release with the new notes.

Do this from a green `main` — it releases whatever is there. The workflow
no-ops when no notable commits have landed since the last release.

## From a tag push

If you prefer to bump locally, write the changelog section before tagging:

```bash
version=0.4.3                              # choose the next version from the commit types
npm version "$version" --no-git-tag-version
bash scripts/changelog.sh release "$version"
bash scripts/changelog.sh check
git add package.json CHANGELOG.md
git commit -m "chore(release): $version"
git tag -a "v$version" -m "v$version"
git push --follow-tags                    # triggers the tag-push release workflow
```

Start with a clean working tree. The explicit commit includes the changelog
and passes the Conventional Commit hook. `prepublishOnly` runs the tests and
typecheck again before uploading. A tag push skips npm publishing if that
version already exists, but still creates or updates the GitHub release.

## Before you release

Pick the bump from [Conventional Commits](https://www.conventionalcommits.org/)
since the last release — the highest impact wins: `feat` → minor,
`fix`/`perf` → patch, `!`/`BREAKING CHANGE` → major. `scripts/changelog.sh draft`
previews the next version section from the commit log.

## One-time setup

npm uses [trusted publishing][trusted], so no token is stored in the repo. On
npmjs.com, under `opencode-ember` → Settings → Trusted Publishers, the GitHub
Actions publisher must point at:

- owner: `ozandogrultan`
- repository: `opencode-ember`
- workflow filename: `release.yml`

Renaming that workflow file requires updating the npm setting too. Confirm
the trusted publisher is configured before running the release workflow.

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
