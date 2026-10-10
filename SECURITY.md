# Security Policy

## Supported versions

`ember` is published to npm (`opencode-ember`) and developed on `main`. Only the
latest release and the tip of `main` are supported; there are no maintained
release branches or backports. Upgrade the plugin before reporting an issue:
for a copied installation, run `git pull`, rerun `./install.sh`, and restart
opencode; for an npm-configured plugin, select the latest version in opencode's
plugin configuration and restart. `npm install -g opencode-ember` updates only
the reporting CLI, not the plugin loaded by opencode.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report it
privately using GitHub's [private vulnerability reporting][report]:

1. Go to the [Security tab][security] of the repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the impact, and the steps to reproduce it.

You can expect an acknowledgement within a few days. If the report is valid,
a fix will be prepared and a security advisory published once it is available.

[report]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability
[security]: https://github.com/ozandogrultan/opencode-ember/security
