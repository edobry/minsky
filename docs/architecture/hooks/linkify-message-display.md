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
