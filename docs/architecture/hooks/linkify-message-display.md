# linkify-message-display

Rewrites bare Minsky entity references in assistant output into `minsky://` deeplinks **as the
message is displayed**, leaving the stored transcript untouched.

- **Event:** `MessageDisplay`
- **Enforcement:** none — it never denies, never injects context, and never fails a turn.
- **Override:** `MINSKY_SKIP_TERMINAL_LINKIFY=1` displays every delta unchanged.
- **Source:** `.minsky/hooks/linkify-message-display.ts` (shell) + `.minsky/hooks/entity-linkify.ts`
  (pure transform)
- **Task:** mt#2565 (build) · mt#3459 (the decision) · mt#3914 (the short-id follow-up)

## Why it exists

The deeplink rule used to ask the agent to hand-emit `[mt#2565](minsky://task/mt%232565)` for
every reference it wanted clickable, and to ration those links so long reports did not fill with
markup. mt#3459 counted the result over one working session: **31 markdown links against 232 bare
`mt#NNNN` mentions.** Which references a reader could click depended on where in the message they
fell. The principal raised it twice, the second time as "that's a bug, right?" — about a message
that was fully rule-compliant.

The decision was to move linkification to the display surface rather than tune the authoring
ration, which is the render-time model the cockpit already uses on its own side (mt#3259: bare
refs are linkified against an id-set at render, and stay bare in storage).

## The event contract

Read off the installed client's embedded schema (2.1.226) rather than the changelog, because the
changelog sentence ("transform or hide assistant message text as it is displayed") omits the part
that shapes the implementation.

```
input : { hook_event_name, turn_id, message_id, index, final, delta }
output: { hookSpecificOutput: { hookEventName: "MessageDisplay", displayContent } }
```

The schema's own words: _"Fired with each batch of newly completed lines while an assistant message
streams. Display-only: the stored message and what the model sees are untouched."_ And for the
output field: _"Text displayed in place of the delta. Omit (or return the delta unchanged) to
display the original."_ A sibling note adds that the final flush's delta is empty when the message
ends on a newline, and that `final` is the end-of-message signal regardless.

Dispatch is `forceSyncExecution: true`, keyed `toolUseID: ${messageId}-${index}`. The client
carries two fallback paths — "MessageDisplay hook flush failed; displaying original delta" and
"MessageDisplay hook failed for completed message; emitting original text" — so a hook failure
degrades to the original text rather than breaking the stream.

## What it rewrites, and what it leaves alone

Rewritten: every occurrence of `mt#NNNN` and `PR #N`. Every occurrence, not the first — the ration
existed because hand-authored markup costs the author attention, and at the display surface it
costs nothing.

Left alone, by construction:

- anything inside a fenced code block, **including a fence opened in an earlier delta**
- inline code spans, blockquote lines, existing markdown links, angle-bracket autolinks, URLs
- a trailing partial line, unless `final` is set, so a reference split across two deltas can never
  be rewritten from half a match

The degradation direction is always "leave it bare": a reference the hook declines to touch
renders exactly as the model wrote it, which is the pre-mt#2565 behavior.

## Two design constraints worth knowing before changing it

**It is in the display hot path.** The event fires per batch of completed lines, not once per
message, so the hook loads no domain code and performs no DB or network IO. Measured cost is ~22ms
per invocation (20 runs of the compiled hook against a representative delta) — process startup plus
one small state-file read. Anything added here is paid many times per message.

**Short ids cannot be linkified here.** `mt#2565` → `minsky://task/mt%232565` is a pure string
transform of the visible label. `ask#N` / `mem#N` / `ws#N` are not: ADR-029 makes the full UUID the
sole deeplink target, so resolving one needs an id-set this path cannot read. They stay bare.
That is the class mem#623 R6 measured failing — 6 of 6 derivable refs linked, 0 of 3 short ids, in
a message handing the principal decisions — so it matters, and mt#3914 owns it with a cached map
following ADR-028 D7(5)'s cache-and-sweep pattern.

## Why it is not on the guard dispatcher

ADR-028 D1 asks for one process per lifecycle event, and this is exactly that: the sole
`MessageDisplay` hook. What it does not do is join `GUARD_REGISTRY`, for two reasons the ADR itself
supplies. The dispatcher resolves transcript candidates and writes fire-log records per invocation,
and D7(5) rules out routing per-invocation IO into a hot path — this is the hottest event in the
harness. And a guard's outcome is a decision (deny, or inject context); this hook's output is a
text transform, which `GuardOutcome` cannot express.

If a second `MessageDisplay` consumer ever appears, the right move is a `dispatch-messagedisplay.ts`
entrypoint with a transform-shaped outcome — not a second `settings.json` command.

## Cross-references

`.minsky/rules/cockpit-deeplinks.mdc` (the authoring rule this narrows) ·
`docs/rules-rationale/cockpit-deeplinks.md §The one-link-per-entity ration is provisional` ·
`docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md` (D1, D7(5)) ·
`docs/architecture/adr-029-numeric-short-ids-foundation.md` ·
`.minsky/hooks/bare-entity-ref-scan.ts` (the detector whose `mt#` / `PR #` classes this largely
retires on Claude Code) · mem#623 (the linked-reference-actionability family).

## Short ids, via a cached map (mt#3914)

The constraint above — short ids cannot be linkified here — was answered by a cache, not by
giving this hook DB access. `ask#N` / `mem#N` / `ws#N` now linkify against a **short-id→UUID map**
written out-of-band by `startShortIdMapSweeper` (a cockpit-side sweep), following ADR-028 D7(5)'s
cache-and-sweep pattern.

The hook cannot read the DB itself, and this is measured rather than assumed: a hook process's
connect cap sits BELOW the measured cold-connect time (mt#3744 / mt#3879), so a direct read would
resolve nothing while adding its full timeout to the hottest event in the harness.

Coverage is therefore best-effort by construction, and the failure direction is fixed: **an
unmapped id stays bare; a wrong target is never emitted.** An id minted since the last sweep, or
any id at all when no cockpit is running, is simply not linked.

Cost of carrying the map: measured **21ms per invocation with a 407KB map, against 20ms without**.

The complement — the ids this path cannot resolve — is exactly what `turn-end-bare-ref-scan.md`
flags, and mt#3960 made that scan read this same map so the two stay in step.

## The fired-evidence channel (mt#4145)

### The gap this closes

Everything above describes a hook that is deliberately invisible: off the guard dispatcher, no
fire-log record, no domain code, and — in its own words — "every failure path here is a no-op."
That is correct for the DISPLAY. It was also true for OBSERVABILITY, and those are separable
concerns that the original design conflated.

Three layers had already stood down on the strength of this hook working:

1. `cockpit-deeplinks.mdc` retired the authoring ration for `mt#` / `PR #`.
2. **mt#3897** retired those same classes from `turn-end-bare-ref-scan`'s warn set, on the
   recorded grounds that "the display linkifier repairs them at render time."
3. **mt#3937** made the advisory disclose its carve-outs, which presumes the carved-out class is
   covered downstream.

Nothing verified the hook had ever fired. A `grep -c` over the live 99 MB fire log returned **0**
records under either name (mt#4129 found the same from the catalog side). So a silent stop — a
client contract change, a PATH problem, a `bun` resolution failure — left no trace anywhere while
all three layers had already stopped watching. **An operator noticing bare refs was the only
detector**, which is exactly how the 2026-08-13 incident (mem#623 R8) surfaced.

### What it writes, and what it costs

One line of `~/.local/state/minsky/linkify-fire-log.jsonl` per **completed message** — not per
delta:

```json
{
  "at": "2026-08-16T22:53:40.563Z",
  "messageId": "m-at1",
  "deltas": 1,
  "totals": {
    "task": 1,
    "changeset": 1,
    "ask": 0,
    "memory": 0,
    "session": 0,
    "shortIdUnresolved": 0
  }
}
```

The running tally rides the fence-state record this hook **already writes per delta**, so the
per-delta hot path gains no IO at all; the only added write is one append when a message ends.
That is ADR-028 D7(5)'s own prescription ("cache + periodic sweep, splitting the expensive read
out of the per-turn hot path"), so this MATCHES the constraint rather than deviating from it.

**Bounded by ROTATION, not by an in-place rewrite** — past 256KB the active log is `rename`d to
`linkify-fire-log.jsonl.1` and a fresh one starts; the reader consumes both. The obvious
alternative (read the file, write back the last N lines) shipped in the first revision of this
change and was caught in review as a **durability hole**: one hook process runs per delta and the
state dir is shared across concurrent clients, so any record appended between the read and the
write is silently discarded by the write — in the one file whose entire purpose is durable
evidence. `rename` is atomic, destroys nothing, and a racing writer's open handle follows the
renamed inode, so its records land in the rotated file rather than vanishing. Re-checking the size
before rewriting, the cheaper fix, would only narrow that window.

**Atomic rename is necessary and not sufficient, which cost a second round.** With N processes
flushing at once, several can stat the oversize file before any of them renames: the first moves
the full log to `.1`, and the second renames the _fresh, nearly-empty_ log over the top of it,
destroying precisely what rotation exists to preserve. Renaming atomically is not the same as
**deciding** to rename atomically. The decision is serialized by an `fs.openSync(lock, "wx")` —
create-if-absent, atomic — so exactly one process rotates and the losers skip the pass entirely
(the log sits slightly over its cap until the next flush, which costs nothing). The size is
re-checked under the lock so a queued process does not rotate an already-fresh file. A lock older
than 60s is treated as stale and cleared, for the process that dies mid-rotation.

Measured, with a deliberate control — the numbers matter because the failure is intermittent:

| Rotation decision                 | Runs    | Result                                                                                             |
| --------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| Serialized by the lock (shipped)  | 10 / 10 | all 1,746 records visible                                                                          |
| Lock made non-exclusive (control) | 6       | **3 runs lost nearly everything** — 1,738 seeded → 2, 3, and 4 records visible; the other 3 passed |

Note the control's passing runs. A single green run of this probe is compatible with the bug being
present, which is how the first fix looked correct before a repeat run caught it.

**`shortIdUnresolved` is not a link count.** It records short-id refs seen in prose that stayed
BARE because the map could not resolve them. A small non-zero value is normal (a just-minted id
the out-of-band sweep has not picked up); a sustained spike is the signature of an absent or stale
map, which previously degraded in total silence.

### The stdout hazard this design exists around

The obvious implementation — print the tally — would have been catastrophic and silent. mem#832
measured that Claude Code **discards a hook's entire output** if stdout carries anything besides
the one JSON object: no error, exit 0, decision ignored. An evidence channel on stdout would
therefore have disabled the very linkification it was added to prove, and looked fine doing it.
Everything here writes to a file; diagnostics go to stderr. `scripts/verify-linkify-fire-log.ts`
asserts the round-trip explicitly (`JSON.stringify(parse(stdout)) === stdout.trim()`).

### Reading it

```
bun scripts/check-linkify-liveness.ts              # report, always exits 0
bun scripts/check-linkify-liveness.ts --window 6   # narrow the window
bun scripts/check-linkify-liveness.ts --json       # machine-readable
bun scripts/check-linkify-liveness.ts --assert-live # exit 1 unless verdict is `live`
```

Four verdicts, and the distinction between the middle two is the whole point:

| Verdict       | Meaning                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `live`        | Ran, and rewrote ≥1 ref in the window.                                                                                                 |
| `ran-idle`    | Ran, rewrote nothing. **Legitimate for a quiet window** — a separate fact from not running, which nothing could previously tell apart. |
| `no-evidence` | No records in the window.                                                                                                              |
| `never-ran`   | No log at all, and no in-flight state.                                                                                                 |

**The verdicts are EVIDENCE claims, not firing claims.** The writer swallows its own errors by
design (the display outranks the channel), so `no-evidence` cannot mean "the hook did not fire" —
only that no evidence survived. The headline says "bounded to the fire log" for that reason, per
`claim-confidence.mdc`'s rule on bounding a negative to the channel actually checked. This matters
downstream: **mt#4174** gates an enforcement-posture change on this output, and a verdict that
overclaimed would propagate straight into a warn storm.

One known hole, named rather than hidden: the flush rides the harness's `final` signal, so a
stream that ends without one (client crash, interrupt) never writes its record. The leftover
fence-state file is what keeps that case from reading as `never-ran`.

### What it does NOT do

It does not change any enforcement posture. Making `turn-end-bare-ref-scan`'s `mt#` / `PR #`
carve-out conditional on this evidence was mt#4145's SC4 and is **split out to mt#4174** by
operator decision on ask#8640 — that is an enforcement-posture change, which mt#3769 routes to the
operator, and it was deferred rather than authorized so the decision can be made with real
measurements in hand.
