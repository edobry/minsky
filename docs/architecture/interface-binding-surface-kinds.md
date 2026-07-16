# Operator-interface binding: surface kinds (v0)

This document describes the v0 slice of the operator-interface binding
concept shipped by mt#1628: what a "surface kind" is, the two values v0
recognizes, how they're computed, and the local-only constraint. It is the
reference for the `InterfaceBinding` type and the iTerm-tab correlator.

**Scope note.** This is the v0 slice only. The broader, polymorphic
`InterfaceBinding` design (VS Code windows, Claude desktop, autonomous
loops, CI runners, and the stale-but-bound / stale-and-unbound alarm
semantics across all of them) is mt#1506's ADR, still in PLANNING at the
time this doc was written. Nothing here should be read as the final schema
— it is deliberately narrow.

## What a surface kind is

A Minsky session (`SessionRecord`) identifies an agent _process_
(`agentId`, per ADR-006) and its activity recency (`liveness`, per mt#951).
Neither says anything about the operator-facing _surface_ driving that
process — the terminal tab, IDE window, or other UI the operator would use
to interact with it. `interfaceBinding` fills that gap: it classifies which
kind of surface (if any) a session is currently, confirmably bound to.

## The v0 surface-kind enum

```ts
type SessionSurfaceKind = "iterm-tab" | "unbound";
```

Defined in `packages/domain/src/interface-binding/types.ts`. Deliberately
hardcoded to these two values — see the Scope note above.

| Kind        | Meaning                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iterm-tab` | The session is confirmed bound to a currently-open iTerm2 tab. `surfaceId` carries that tab's `TERM_SESSION_ID`.                                                                                                    |
| `unbound`   | No currently-open iTerm2 tab is confirmed bound to this session — covers "never was," "was, but the tab has since closed," AND "not applicable" (hosted Minsky, non-macOS local Minsky, correlator hasn't run yet). |

v0 does **not** distinguish "closed tab, agent still alive" (recoverable —
an operator could resume) from "genuinely never bound." That finer-grained
matrix — the four-cell `(agent alive|dead) × (surface bound|unbound)`
semantics, and the cockpit alarm-on-orphan behavior it would drive — is
explicitly mt#1506's design to make, not this task's.

## How a binding is computed: the iTerm-tab correlator

`packages/domain/src/interface-binding/iterm-correlator.ts`. Two-step
design that deliberately reuses existing infrastructure rather than
re-deriving session↔terminal correlation from scratch:

1. **Candidate signal — already captured, no new work.** mt#2284/mt#2285
   already ship a session-grain runtime-attachment layer: each session's
   own process self-registers a `terminalContext` env bag (`TERM_PROGRAM`,
   `TERM_SESSION_ID`, etc.) at startup, confirmed live via pid-liveness
   checks (`listLiveSessionAttachments()`, `packages/domain/src/session/attachment.ts`).
   The mt#2285 focus-adapter registry already proves, in this codebase,
   that iTerm2's `TERM_SESSION_ID` is the correct native per-tab identity
   (`packages/domain/src/session/focus/adapters.ts`'s `iterm2FocusAdapter`
   keys its AppleScript activation off exactly this value). The correlator
   reuses this as its candidate signal instead of the cwd-prefix / tab-name
   / tty-to-pid heuristics the original task spec sketched — those
   heuristics predate mt#2284/mt#2285 and are strictly less precise than an
   identity iTerm2 itself hands out.
2. **Liveness confirmation — the genuinely new piece.** A session's process
   can outlive the tab it started in (operator closes the tab; the agent
   process, now orphaned, keeps running). The correlator enumerates every
   currently-open iTerm2 session id via a read-only AppleScript
   (`listLiveItermSessionIds()`, walking `windows → tabs → sessions of t`,
   mirroring the loop shape and escaping discipline of the mt#2285 focus
   adapter's activation script) and checks whether the candidate
   `TERM_SESSION_ID` is still in that live set. Only then is `iterm-tab`
   confirmed; otherwise `unbound`.

Pure classification (`classifyAttachment()`) is unit-tested without any
subprocess execution; `listLiveItermSessionIds()` takes an injectable
`CommandExecutor` seam (reused from `../session/focus/types.ts`) so
production wiring is the only code path that ever spawns a real
`osascript` process — the same hard-sandbox discipline mt#2285 established.

## Persistence: a `SessionRecord` field, not a new table

`SessionRecord.interfaceBinding` (JSON text column `interface_binding` on
`sessions`, migration `0057_session_interface_binding.sql`) — matching the
existing `prState`/`pullRequest` embedded-JSON convention. The full
tradeoff writeup (including why this deliberately does NOT reuse
`presence_claims`, despite that table already carrying the candidate
`terminalContext` signal) lives as a Design Decision comment directly above
the field in `packages/domain/src/session/types.ts` — read it there for the
authoritative rationale; this doc summarizes.

## Reading a binding: `session_get` / `session_list`

Both MCP tools always return a concrete `interfaceBinding` — never
`undefined` — via `resolveInterfaceBinding()`
(`packages/domain/src/interface-binding/read.ts`), which defaults an
unobserved session to `{ kind: "unbound", lastObservedAt: <best-known timestamp> }`
at read time. Storage stays sparse (no backfill needed for existing rows);
the read contract stays total. This is what makes "hosted-Minsky sessions
report `surface_kind: unbound` without errors" true without the correlator
ever running against a hosted deployment.

## Running a correlation pass: `session bindings refresh`

```
mcp__minsky__session_bindings_refresh
```

(`src/adapters/shared/commands/session/bindings-command.ts`.) v0 ships this
as an on-demand, operator/CLI-invoked command — the same shape mt#2284's
`session ps --reap` established for a v0 manual-invocation pattern in this
exact domain (that reaper is also not wired to a scheduler). Periodic
scheduling — e.g. wiring `runItermCorrelationPass()` into the cockpit
daemon's `createIntervalSweeper` factory (`src/cockpit/sweepers.ts`), which
already runs several 5–10 minute local-only sweeps with DB access — is a
natural fast-follow once operator feedback confirms a cadence, but is not
required for this v0 slice.

## The local-only / deployment-mode gate

`isLocalItermCorrelationSupported()`
(`packages/domain/src/interface-binding/deployment-mode.ts`) gates every
entry point into the correlator. Two conditions, both cheap and
synchronous:

1. **Not hosted.** Reuses the existing `isHostedMode()` flag
   (`packages/domain/src/configuration/guard.ts`), set once at MCP-server
   boot: `--http` flips it `true`; local/stdio launches never call
   `setHostedMode`, so it stays `false`. This is already the codebase's
   source of truth for "is this an operator's local machine or the hosted
   service" — reused rather than inventing a second mechanism.
2. **`process.platform === "darwin"`.** iTerm2 is macOS-only; a local
   (non-hosted) Minsky running on Linux/Windows has nothing to correlate
   against even though it isn't "hosted."

The gate is checked **before** any `osascript` invocation or database
read — a hosted or non-darwin caller never shells out at all, which is
what the "hosted-Minsky sessions... the iTerm correlator skips gracefully"
success criterion requires.

## Cockpit surfacing

The Agents widget's per-session row (`AgentRow.interfaceBinding`,
`src/cockpit/widgets/agents.ts` + `src/cockpit/web/widgets/Agents.tsx`)
renders a small `Anchor` icon only for the confirmed `iterm-tab` case — no
icon at all for `unbound`, matching the "lightweight cockpit hook" framing
for v0. This is distinct from the existing attachment-state indicator
(mt#2286, `AttachStateIndicator`): that answers "is _something_
self-registered as live"; this answers "specifically, is a currently-open
iTerm2 tab bound to this session."

## Cross-references

- mt#1628 — this v0 slice (task spec has the full acceptance-test list).
- mt#1506 — the broader `InterfaceBinding` ADR (PLANNING; NOT touched by
  this task per its own explicit instruction — see mt#1628's task
  description).
- mt#2284/mt#2285/mt#2286 — the session-grain runtime-attachment substrate,
  focus-adapter registry, and Agents-widget attachment-state indicator this
  v0 slice builds directly on top of.
- `packages/domain/src/session/types.ts` — the `SessionRecord.interfaceBinding`
  Design Decision comment (authoritative persistence-choice rationale).
- `packages/domain/src/interface-binding/` — the domain module (types,
  deployment-mode gate, correlator, read-side default).
