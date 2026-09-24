# opencode-ember

[![CI](https://github.com/ozandogrultan/opencode-ember/actions/workflows/ci.yml/badge.svg)](https://github.com/ozandogrultan/opencode-ember/actions/workflows/ci.yml)

Keep an LLM prompt cache **warm across a break**, guard a **cold rewrite**
before you pay for it, and see exactly what the break cost.

A port of [`cache-tax`](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax)
to [opencode](https://opencode.ai). One self-contained plugin file, no runtime
dependencies.

> Why "ember": a banked fire you keep smoldering while you are away.

## What it does

- **The cache stays warm by default.** Every session stays armed while opencode runs;
  after the cache tier has almost lapsed, the plugin sends one request over a
  **fork** of the session. The fork shares the session's model, agent, tools and
  system prompt, so its prefix is byte-identical and only appends: the provider
  answers from cache and the TTL refreshes. No heartbeat messages ever enter the
  real conversation. `/keepwarm off` stops it for the session and turns the
  default off.
- **`/ember guard warn` (default) shows the price and sends anyway.** When the TTL has
  lapsed and the context is large, a graceful warning is shown while the message sends.
  `/ember guard refuse` hard blocks cold sends and shows an informative error in the turn,
  preventing accidental rewrites until you switch to `warn` or `/clear`.
- **`/ember` keeps score.** Warm or cold, context size, cold-rewrite price, the
  break-even (how many pings cost one cold write, and the idle that covers),
  keepwarm state, guard mode, and this session's cold writes.

## Requirements

- [opencode](https://opencode.ai) (server plugins, `chat.message` +
  `command.execute.before` hooks; tested on 1.18.x).
- A provider with prefix caching. Anthropic is the best-supported; pricing
  tables for Fable/Opus/Sonnet/Haiku are built in.

## Install

### From this repo (recommended)

```sh
git clone https://github.com/ozandogrultan/opencode-ember.git
cd opencode-ember
./install.sh
```

Then **restart opencode** — plugins are loaded at startup only.

`install.sh` asks opencode for its own config directory (`opencode debug paths`)
and copies `ember.ts` into `<config>/plugins/`, backing up any existing file.

### Manually

Copy `ember.ts` to one of:

- `~/.config/opencode/plugins/ember.ts` — all projects (global)
- `<project>/.opencode/plugins/ember.ts` — one project

### From npm

```json
{ "plugin": ["opencode-ember"] }
```

in `opencode.json`, then restart opencode.

## Usage

```
/keepwarm [6h|90m] [every 2m] [ttl 1h] | always | status | off
/ember [guard warn|refuse]
```

| command | effect |
| --- | --- |
| `/keepwarm` | refresh always-on warming (or arm six hours if the default is off) |
| `/keepwarm 90m` | a window of your own (`2h30m`, `6h`, …) |
| `/keepwarm always` | keep this and future sessions armed until closed (already the default) |
| `/keepwarm 6h every 2m` | override the ping period (floor 1m) |
| `/keepwarm 6h ttl 1h` | assume the 1-hour cache tier |
| `/keepwarm status` | the status line |
| `/keepwarm off` | stop, forget the window, turn the default off |
| `/ember` | the card |
| `/ember guard warn` | show the price and send (default) |
| `/ember guard refuse` | hard block cold sends |

Warming belongs to each session. By default it renews as long as opencode is
running; explicitly timed windows end after their duration. A second session
gets its own timer, and a resumed session restores its setting. Run
`/keepwarm off` to disable the default and warm only on request. A stopped
process, sleeping computer or failed ping can still let the provider cache expire.

## The 5-minute tier (read this)

opencode marks `cache_control` **without a `ttl`**, i.e. the **5-minute** tier,
so pings land at ~4 minutes, not the original mod's 50. If your provider
actually holds an hour, run `/keepwarm 6h ttl 1h` (or set
`EMBER_TTL_SECONDS=3600`) for a ~54-minute cadence.

Economically that matters: on a 200k-token context a cache read is ~$0.05 and a
cold write ~$4, so ~80 pings cost one cold write. Warm a one-hour break and you
win; warm a whole working day on the 5-minute tier and you are near break-even.

Always-on warming can keep paying for cache reads beyond six hours while the
session remains open. Turn it off with `/keepwarm off` or use an explicit
duration if you would rather bound the cost per session.

## It will not invalidate your cache

- Pings reuse the session's **exact** model, agent, tools and system prompt and
  send a constant one-line prompt. They only append.
- After every ping the plugin checks the usage: if it read nothing, or wrote at
  least a tenth of what it read, it concludes the cache was already gone and
  **stops itself** rather than hammering a cold cache.
- An explicitly timed window expires without editing or clearing the session.

## Configuration

| env var | default | meaning |
| --- | --- | --- |
| `EMBER_TTL_SECONDS` | `300` | assumed cache tier |
| `EMBER_MIN_CONTEXT` | `50000` | cold-guard context floor, tokens |
| `EMBER_MIN_PING_SECONDS` | `60` | ping floor |

State lives in `~/.local/share/opencode/ember.json` and is stamped with a
version. A state file written before warming was on by default is upgraded
silently: its `always: false` was the old default rather than a choice, so it is
ignored once and the new default applies. Delete the file to reset.

## Testing

Free (no model call):

```sh
opencode debug config | grep -A2 -E '"keepwarm"|"ember"'   # loaded?
```

```
/keepwarm status     # "keepwarm off"
/keepwarm 6h         # arms
/ember               # card
/ember guard warn    # switch guard
/keepwarm off
```

Cold guard, for about one small call — launch with a 5-second pseudo-TTL and a
1-token floor, send a message, wait 6s, send another (blocked):

```sh
EMBER_TTL_SECONDS=5 EMBER_MIN_CONTEXT=1 opencode
```

Prove a ping shares the cache (one cache read) — in a warm session with real
context:

```
/keepwarm 1h every 1m
```

Wait a minute, then run `/ember`. Its last-ping cache read should be close to
your context size: that is the proof the fork hit the main cache. Successful
pings are silent; failures and stops still show a toast. If the ping reports
no cache activity, the provider may not cache this prefix or report cache
usage, so keepwarm stops rather than paying for unverified pings. Stop notices
appear briefly in the TUI (five seconds); `/keepwarm status` or `/ember` shows
the reason afterward.

## How it works

`chat.message` + `chat.params` (cold guard), `event` (token/price tracking, timers) and
`command.execute.before` (the two commands, aborted before any model call).
Pings go through `session.fork` → `session.prompt` → `session.delete`.

## Credits

Ported from [`karanb192/claude-code-mods` → `cache-tax`](https://github.com/karanb192/claude-code-mods/tree/main/plugins/cache-tax).
The design, the price arithmetic and the safety rules are theirs; this is the
opencode translation.

## License

MIT © Ozan Dogrultan
