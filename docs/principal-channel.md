# The principal channel — talking to the swarm from a phone

**Status:** merged and wired into the cockpit daemon; outbound live-verified,
inbound pending a live round-trip. Tasks: mt#3228 (the channel), mt#3230 (the
config switch). Program: mt#2230 (harness-host observe→drive ladder), of which
this is the first Rung-3 (mt#2238) surface.

## What it is

A two-way Telegram channel between the principal and the Minsky swarm.

- **Outbound** — any agent can call `principal_notify` to reach the principal's
  phone.
- **Inbound** — the principal messages the bot; the cockpit daemon picks it up
  and drives a local `claude` conversation with it, then sends the answer back.

## Why the poller runs locally

mt#2238 frames the general problem: drive a local agent from a remote surface,
which normally needs an authenticated inbound cloud→local control channel — an
RCE-adjacent surface with a threat model as a success criterion.

Telegram long-polling dissolves it. The daemon makes an **outbound** HTTPS
request to `api.telegram.org`; the principal's messages arrive as its response.
No inbound port, no tunnel, no NAT traversal, no new ingress to secure —
Telegram itself is the relay.

The trade is honest: **the channel is live only while the cockpit daemon runs.**
The swarm runs on that machine, so when it is down there is nothing to talk to.
Cloud-originated _outbound_ alerts (the reviewer's Telegram sink) are
independent and keep working.

**Exactly one process may poll a given bot.** Telegram hands each update to one
`getUpdates` caller and, once the offset acknowledges it, never again. The
reviewer service only ever _sends_; the cockpit daemon is the sole poller. While
it runs it also consumes the updates `scripts/reviewer-alerts/discover-chat-id.ts`
reads, so that script reports "no chats visible" — expected, not a regression.

## What answers you

One **standing driven session** — a long-lived `claude` conversation, reused
across messages, that is your counterpart on the phone. It holds full MCP access
to the substrate and commands the swarm on your behalf.

Reuse is a grounding requirement, not an optimization: "focus on that one" only
resolves against what was just said. A session per message would force you to
restate context every time.

The router does not classify intent. Free text goes to that conversation, which
works out what you meant. Only two cases take a deterministic path, where
determinism beats an agent turn:

| You send                  | What happens                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `/answer <ask-id> <text>` | Answers that ask directly; the existing wake-bridge resumes whichever agent was waiting on it. |
| `/stop` or `/halt`        | Interrupts the current turn.                                                                   |
| `/new` or `/reset`        | Abandons the conversation; the next message starts fresh.                                      |
| anything else             | Goes to the standing conversation.                                                             |

An unrecognized `/command` is _not_ an error — it falls through to the agent,
which can explain itself. A channel that answers "unknown command" to a human
typing naturally is a channel you stop using.

## Setup

Nothing, on this deployment. The channel reuses the reviewer's existing bot, and
both its token and the principal's chat id are already set on the Pulumi stack —
the chat id's presence is itself proof the bot has been messaged, which is the
one step Telegram requires a human to perform (there is no API to look up a chat
id).

It does **not** auto-enable off the mere presence of credentials, even though
they resolve today: those were provisioned for reviewer alerts, and starting a
local-`claude`-driving surface off them would be a silent capability escalation.

To turn the inbound half on:

```bash
minsky config set principalChannel.enabled true
```

Then restart the cockpit daemon. That is the whole switch — it works regardless
of how the daemon was launched, and it survives a reboot.

That last part is why it is config rather than an environment variable
(mt#3230). The cockpit-tray app spawns the daemon inheriting the **macOS GUI
session environment** (`supervisor.rs`'s `spawn_daemon` overrides only `PATH`),
which your shell is not part of — so a shell `export` never reached it, and the
`launchctl setenv` workaround did not survive a reboot.

| Setting                           | Effect                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `principalChannel.enabled`        | `true` starts the inbound poller. Nothing else enables it.                                  |
| `principalChannel.cwd`            | Working directory for the standing conversation. Defaults to the daemon's.                  |
| `principalChannel.permissionMode` | `default` tightens the session below the driven-session default of `bypassPermissions`.     |
| `principalChannel.allowedUserIds` | Telegram sender ids. Required for a group chat; derived from the chat id for a private one. |

Each has an environment override, which **wins over config** — the environment
source is merged last, so a deployed service can keep setting them:
`MINSKY_PRINCIPAL_CHANNEL_ENABLED`, `..._CWD`, `..._PERMISSION_MODE`,
`..._ALLOWED_USER_IDS` (comma-separated). Credentials override the same way via
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.

On a fresh deployment with no bot yet: create one with `/newbot` in
[@BotFather](https://t.me/BotFather), store the token through the cockpit
credentials widget's Telegram provider (never through chat), message the bot
once, then run `bun scripts/reviewer-alerts/discover-chat-id.ts` and set the
result with `pulumi -C infra config set reviewer-telegram-chat-id <id>`.

## Verifying

```bash
bun scripts/principal-channel/verify-send.ts ["message"]
```

Run it from a checkout whose `infra/` holds the stack config — the main
workspace, since `Pulumi.<stack>.yaml` is gitignored and absent from session
clones. It exercises `notifyPrincipal` itself, so a PASS means the
agent-invocable surface works, not merely that Telegram is reachable.

## Security

An accepted message becomes a user turn in a local `claude` process. **The
channel is only as safe as the Telegram account that drives it.**

- **Allowlist first.** The check runs before parsing, before logging, before
  anything. Other chats are counted and dropped.
  - **Private chat** (the shape a discovered chat id has): both the chat id and
    the sender id are enforced. Telegram gives a private chat the same id as the
    user on the other end, so the sender allowlist is derived from the chat id —
    exact, and it rejects an update with a spoofed or missing `from` that would
    otherwise match on chat alone.
  - **Group chat** (negative id): chat and sender are genuinely different, and
    there is nothing to derive. Without `principalChannel.allowedUserIds` the
    channel enforces chat-only, meaning **any member of that group can drive the
    swarm**. The daemon logs a warning at startup when this is the case.
- **Refused messages are not stored verbatim.** A rejected message's metadata is
  recorded but its text is not — otherwise an unauthorized chat could write
  attacker-chosen content into the event feed the operator reads.
- **Audit before action.** Every accepted update is written to the append-only
  `system_events` log before any side effect, and a failure to carry it out is
  recorded afterwards as `principal.message_failed` — so the log says both what
  the channel was asked to do and whether it worked. Stored message text is
  bounded (`MAX_STORED_TEXT`), since these rows are never deleted.
- **Permission mode.** Defaults to `bypassPermissions`, matching every other
  driven session the cockpit spawns: in headless `-p` mode a permission prompt
  has nowhere to go, so `default` leaves the session able to answer questions
  but not act. Deployments wanting the tighter posture set it explicitly.

`principal.message_rejected` is classified **actionable** (an unauthorized party
attempting to drive your swarm is something you must see);
`principal.message_received` is informational.

## Durability

The append-only event log does three jobs at once, which is why there is no
separate cursor table:

1. the audit trail for an RCE-adjacent surface,
2. the poll cursor across daemon restarts (max recorded `updateId`),
3. the idempotency record (`payload.token` = `telegram:update:<id>`).

Job 2 needs one extra piece. Telegram also hands over updates this version does
not parse — an `edited_message`, a future type — and the poller deliberately
advances past them so one cannot wedge the channel. Those produce no message
row, so a cursor derived only from message rows would never cover them and
Telegram would re-serve the same update forever. When the message rows fall
short, the poller records an explicit `principal.poll_advanced` row carrying the
position.

Telegram retains undelivered updates for 24h, so a daemon restarting without a
readable cursor re-receives up to a day of messages. The token dedupe is what
makes that harmless rather than a replay of a day's instructions.

## Related

- mt#2238 — Rung 3, remote interface / local execution (this is its first surface)
- mt#2237 / mt#2750 / mt#3038 — the driven-session host this consumes
- mt#3095 — conversation-keyed identity; steering an _arbitrary_ live
  conversation from the phone waits on it
- mt#3227 — the sibling mobile surface (watch + poke, rather than converse)
- mt#1409 — async messaging transports for Asks (this task's parent)
