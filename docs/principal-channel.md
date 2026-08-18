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

A **driven session** — a long-lived `claude` conversation that is your
counterpart on the phone. It holds full MCP access to the substrate and commands
the swarm on your behalf.

Reuse is a grounding requirement, not an optimization: "focus on that one" only
resolves against what was just said. A session per message would force you to
restate context every time.

## How to tell the channel is even running

The acks below tell you a message was picked up. They cannot tell you the
channel is **alive** — every one of them is set by the poller, so if the poller
never started, none of them fire and an unanswered message looks exactly like an
agent with nothing to say. That is not hypothetical: on 2026-08-03 a transient
DNS failure against the Pulumi backend stopped the channel from starting **five
times**, and each was noticed only when a message went unanswered (mt#3608).

`GET /api/health` therefore reports the channel's own state:

```json
{
  "principalChannel": {
    "state": "running",
    "chatId": "167346572",
    "since": "2026-08-17T03:48:02.000Z",
    "lastProgressAt": "2026-08-17T03:49:17.000Z",
    "dedupe": {
      "mode": "durable",
      "since": "2026-08-17T03:49:17.000Z",
      "unrecordedCount": 0
    }
  }
}
```

| `state`        | Means                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`      | The poller is up AND has made progress recently. Carries `chatId`, `since`, `lastProgressAt`, `dedupe`.                                       |
| `stalled`      | Launched, then stopped making progress. Carries `chatId`, `since`, `lastProgressAt`, `staleForMs`, `thresholdMs`. **Not consuming messages.** |
| `disabled`     | Turned off in config (`principalChannel.enabled` is not `true`). Not a fault.                                                                 |
| `starting`     | Mid-launch. Transient; a value that persists here means startup threw.                                                                        |
| `retrying`     | A credential read FAILED and is being retried with backoff. Carries `reason`, `attempts`, `lastAttemptAt`, `nextAttemptAt`.                   |
| `failed`       | An exception AFTER credentials resolved (poller/actuator construction). Carries `reason` only. **The channel is not running.**                |
| `unconfigured` | No bot token / chat id is set. Carries `reason`. Operator action needed.                                                                      |

Field lists above are exhaustive per variant and match `PrincipalChannelStatus`
in `src/cockpit/principal-channel-launch.ts`, with one qualification: `dedupe` is
typed OPTIONAL on `running`, while every other field listed is required. A live
`running` payload always carries it — the poller and the dedupe are created
together, so reaching `running` means one exists. The optionality covers a status
seeded WITHOUT a poller, which only the test-only setter does. Read an absent
`dedupe` as "not reported", never as `durable`.

Two rows were wrong before mt#4183 and are corrected rather than carried forward:

- **`failed` never carried `attempts`.** mt#3689 removed it: there it was always
  the literal `1` and counted nothing, since that failure happens once, after
  credentials have already resolved — so one field was carrying two meanings
  across two fault classes. `state` already separates them.
- **`failed` is no longer reachable from a credential-read failure.** mt#3683
  removed that path's retry ceiling, so a failing read keeps retrying instead of
  settling here. The row's old wording ("could not be read after retries")
  described behaviour that no longer exists.

`retrying`'s row was incomplete in the other direction — it omitted
`nextAttemptAt`, which is the field that actually discriminates "still working
the problem" from "stuck".

**`running` used to be a latch, and this section used to say so wrongly.** Until
mt#4183 the sentence above read "reports the channel's own state, **independent
of the poller**" — which was false when written. `running` was assigned once, at
the moment the poller was launched, and no code path ever wrote it again. It
therefore reported the state the channel reached at STARTUP, not its state now.
On 2026-08-16 the poll loop parked on an unsettled await and this field said
`running` for ~44 hours while Telegram held undelivered updates and the daemon
had zero connections to `api.telegram.org`.

What makes it true now is that `running` and `stalled` are **projected on read**
rather than stored: `lastProgressAt` comes from the poll loop's own progress
reports into the sweep-liveness registry (mt#4185 registers the poller as
`principal-channel poll`; see `GET /api/sweeps`), and `stalled` is computed when
that stamp — or, before the first one lands, `since` — is older than the
registry's own stall threshold. There is no write site for `stalled`, which is
the point: nothing has to remember to update it, so it cannot go stale the way
the latch did.

Read `staleForMs` rather than just the state: "stalled 4 minutes" and "stalled 4
days" call for different responses, and only the number distinguishes them.

### `dedupe` — is the channel still able to tell a replay from a new message?

`running` says the loop is TURNING. It does not say the loop can still recognise
a message it already answered, and those two come apart exactly when Postgres is
unreachable (mt#4252). The channel's dedupe is durable — the idempotency token is
looked up in the append-only event log — so when the database is unreachable the
check is unreachable with it. `dedupe` is the field that separates the two:

| Field             | Means                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`            | `durable` — the last audit write LANDED, so the event log is answering the replay question. `degraded` — the last one FAILED, and a per-process fallback answered it. |
| `since`           | ISO stamp of the write that set `mode`.                                                                                                                               |
| `unrecordedCount` | How many messages this daemon has acted on with NO durable audit row behind them. A total for the process's lifetime, not a gauge — it does not reset on recovery.    |

**`mode` describes the last write the channel attempted, dated by `since` — it is
not a live database probe.** Nothing here polls Postgres; the channel only learns
the database's state by trying to write to it. So a quiet channel keeps reporting
whatever it last observed, and `since` is what stops that being mistaken for a
fresh reading. A `degraded` from four hours ago on a channel nobody has messaged
since means "the last write failed, four hours ago", not "still broken now".

Like `running`/`stalled`, this is **projected, not latched**: `mode` is derived by
comparing the last durable write against the last fallback, so it corrects itself
on the next successful write and nothing has to remember to clear it.

`degraded` is not by itself an outage you must act on — the channel keeps
answering, which is the whole point of the fallback. What it tells you is that
the audit log has a hole in it for those messages, and that dedupe is only as
good as this process's memory: a daemon restart during a `degraded` stretch
empties the fallback, and Telegram may re-serve anything still unconfirmed.
`unrecordedCount` is the size of the hole.

**`retrying` and `unconfigured` are deliberately different states.** The first
means the credentials probably exist but could not be READ — a fault, usually
transient, and retrying is the right response. The second means they were never
set — an operator has to act. Before mt#3608 both reported the same
"not configured" message, which reads as an operator oversight and is why five
faults in one day went unexamined.

This contrast used to name `failed` rather than `retrying`, and that stopped
being true at mt#3683: an unreadable credential no longer exhausts into
`failed`, it keeps retrying. `failed` now means something narrower and later —
construction of the poller or actuator threw AFTER credentials had already
resolved — so it is not the counterpart to `unconfigured` any more.

The tray does not parse this field (it reads only `db` and
`processStartedAtMs`), so it is for operators and the cockpit UI.

## How to tell it heard you

An agent turn can run for a minute or more, so the channel marks progress on
your own message rather than leaving you watching an empty chat.

| Signal             | Means                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 👀 on your message | The message reached the actuator; a turn is starting.                                                                                         |
| "typing…"          | A turn is running. Refreshed continuously for its whole duration.                                                                             |
| 👌 on your message | The turn finished and the reply was delivered.                                                                                                |
| 🤨 on your message | The turn failed, or its reply never reached you. If a reply did arrive, it says what went wrong; if none did, delivery itself is what failed. |

Replies are rendered — bold, italic, code, fenced blocks, links, quotes — via
Telegram's HTML mode. Tables become monospace blocks and headings become bold
lines, because Telegram has no markup for either.

**Replies stream, as a sequence of messages.** Rather than arriving as one blob
when the turn ends, the answer appears as soon as there is any of it and fills
in as it is written. Each run of prose between tool calls is its own message:
the text within a message fills in live, and when the agent stops to use a tool,
that message is finished and the next thought starts a new one — the way a
person types in chat, rather than one message that keeps growing under your eyes.

**Your phone still notifies you ONCE per turn**, on the first message. Every
later message in the same turn is delivered silently, so a turn with six blocks
costs you one notification, exactly as the single-message version did. A block
too long for one Telegram message continues into another, split at a paragraph
or line break rather than mid-word — that split is silent too.

Two things worth knowing about how it settles:

- **Nothing you have already read is taken away.** A turn that uses tools writes
  text around each step, and its final answer is usually shorter than everything
  that streamed. That final answer never overwrites what is already in the chat:
  if it continues the last message it is added to it, if you have already seen it
  nothing happens, and if it is something new — a timeout notice, say — it
  arrives as its own message. (Until mt#3711 it DID overwrite, which is why a
  reply could visibly shrink back down the moment the turn finished.)
- **Streaming can never cost you the reply.** If editing fails partway, the
  complete answer is sent as a fresh message rather than left half-drawn — you
  may see some text twice, which is the deliberate trade. A half-written reply
  that never finishes would be worse than the blob this replaced.

**Telegram's ✓ / ✓✓ checkmarks mean nothing here.** They are a client
affordance between Telegram's servers and your app: the Bot API exposes no
read-receipt or tick state at all, so the bot can neither read nor set them, and
no Minsky pipeline stage can be bound to them. The reactions above are the real
signal — they are the only mechanism that can mark a _specific_ message as
having reached a _specific_ stage.

Every one of these is best-effort by design: a reaction or an indicator can fail
without affecting the reply. That is deliberate — the ack reports on the
pipeline, so it must never be able to break what it is reporting on. The
consequence worth knowing is that a failed ack is SILENT, which is why
`scripts/principal-channel/verify-reaction-emoji.ts` exists: Telegram's reaction
emoji are a fixed allowlist it can revise, and that script re-checks membership
rather than trusting a remembered list.

### One conversation per topic

Telegram supports **forum topics inside a private bot chat** (Bot API 9.3/9.4),
and this channel uses them: **each topic you create gets its own conversation**,
with its own history. Talking about three things means three topics, not three
interleaved threads in one chat you disambiguate by reply-quoting.

Messages in different topics are handled **concurrently**; messages within one
topic stay strictly ordered. A message sent outside any topic goes to the
**standing conversation** — the original single conversation, still there and
unchanged.

Creating a topic is entirely your move. Nothing else opens one: an agent cannot,
and this version of the channel never does. That is deliberate — a new topic is
a push notification plus a durable list entry, so the ability to mint one is the
ability to spend your attention.

Requires two @BotFather toggles on the bot: topic mode, and "allow users to
create topics." With them off, Telegram simply never sends a thread id and the
channel behaves exactly as it did before topics existed.

### Binding a topic to a task

A topic starts **unbound** — it is just a thread about something. Send
`/bind mt#NNNN` inside it to bind it to a task. Binding is in place: the
conversation does not move, fork, or lose history; only the mapping gains the
task reference. Once bound, agent notifications about that task land in that
topic instead of the main chat.

Bind refuses, with an explanation, if the task does not exist or if you send it
outside a topic. It never creates the task.

### Commands

The router does not classify intent. Free text goes to that topic's
conversation, which works out what you meant. Only these cases take a
deterministic path, where determinism beats an agent turn:

| You send                  | What happens                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `/answer <ask-id> <text>` | Answers that ask directly; the existing wake-bridge resumes whichever agent was waiting on it. |
| `/bind mt#NNNN`           | Binds the current topic to that task, so notifications about it arrive here.                   |
| `/stop` or `/halt`        | Interrupts the current turn.                                                                   |
| `/new` or `/reset`        | Abandons the conversation; the next message starts fresh.                                      |
| anything else             | Goes to this topic's conversation.                                                             |

`/answer`, `/stop`, and `/new` all act on **the topic you sent them in** — a
`/new` in one topic does not disturb any other conversation.

An unrecognized `/command` is _not_ an error — it falls through to the agent,
which can explain itself. A channel that answers "unknown command" to a human
typing naturally is a channel you stop using.

### If you delete a topic

Telegram offers bots no way to list their own topics, so the channel keeps its
own record of which topic maps to what. Deleting a topic on your phone makes
that record stale, and the next message aimed at it comes back
`Bad Request: message thread not found`.

That case is reconciled rather than dropped: the stale mapping is discarded and
the message is **re-delivered to the standing conversation** with a note saying
it fell back. A notification is never silently lost to a topic that no longer
exists.

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
- **Permission mode.** `bypassPermissions` — **affirmed by the principal on
  2026-07-26 (ask#6164), not inherited.** It matches every other driven session
  the cockpit spawns, and the alternative is largely inert: in headless `-p`
  mode a permission prompt has nowhere to go, so `default` leaves the session
  able to answer questions but not act.

  The exposure accepted with that choice, stated plainly so anyone re-opening
  the question starts from what was actually weighed: **whoever controls the
  allowlisted Telegram account can run arbitrary commands on the host**, because
  an accepted message becomes a user turn in a local `claude` process with tools
  enabled. The allowlist pins both chat id and sender id, so the blast radius is
  exactly that account — which is why the allowlist, not the permission mode, is
  the control that matters here.

  To tighten anyway: `minsky config set principalChannel.permissionMode default`,
  then restart the daemon. Expect a channel that answers but cannot act.

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
