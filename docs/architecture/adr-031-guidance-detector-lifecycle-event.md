# ADR-031: The lifecycle event the guidance-detector family scans on

## Status

**Accepted** (2026-07-31)

**Amended 2026-08-25 (mt#4531): `wall-of-text-detector` is no longer text-only, and the
classification below is now zero-of-eleven rather than one-of-eleven.** The table in §What the
family actually is classifies that module as the family's ONE text-only member — served entirely by
the `Stop`-recorded `last_assistant_message`, which the vendor documents as carrying "the text
content of Claude's final response." mt#4531 changed what it measures: the over-budget leg now keys
on the LARGEST assistant text block of the turn, not the final one, because the principal reads the
whole turn and a wall in the first block was invisible by construction (mem#664 R7 — 854 words
across four blocks, 597 in the first, measured as 110).

`last_assistant_message` cannot supply a block that is not the final one, so that module now reads
the transcript window for its earlier blocks — the same source sub-operation (3) already reads for
tool calls.

**The decision itself is unaffected, and this amendment does not reopen it.** Sub-operation (2)
still prefers the recorded value for the FINAL block (`resolveFinalAssistantText` is unchanged), so
the lag-tolerance this ADR bought is intact; the event assignment — anchor at `Stop`, detect and
inject at `UserPromptSubmit` — is untouched. What changes is a supporting FACT, and it is worth
naming because §Options rejected leans on it: option (c) ("split by detector — text-only detectors
move to `Stop`") was rejected partly on "it moves **exactly one module**." That count is now zero,
which strengthens the rejection rather than weakening it — there is no longer any module
`last_assistant_message` could fully serve, so the split option has nothing left to buy.

Task **mt#3292**. The event-axis sibling of **ADR-024** (which decides the detection _mechanism_
— regex vs embedding vs learned — and deliberately does not touch the _event_). Read together:
ADR-024 answers "how does a detector match?", this ADR answers "when does it look, and at what?"

No principal ratification gate was triggered. The option that would have required one — moving
injection to `Stop`, which changes when and how the principal receives guidance — is rejected
below; the chosen option leaves the injection moment and the attention model exactly as they are
today. See `## The principal-facing axis`.

## Context

Eleven guidance detectors read the just-completed turn out of `transcript_path` at
`UserPromptSubmit`. Claude Code's hooks reference says not to.

**Verbatim, from the raw markdown of `https://code.claude.com/docs/en/hooks.md`** (fetched with
`curl`, HTTP 200, 242,078 bytes, 2026-07-29; line numbers are into that file). The raw read is
load-bearing: a _summarizing_ fetch of the same page returned a different "verbatim" Stop-section
quote containing a caveat that does not appear in the source.

Line 632, common-input-fields table:

> `transcript_path` | Path to conversation JSON. The transcript file is written asynchronously and
> may lag the in-memory conversation, so it may not yet include the current turn's most recent
> messages when a hook fires. Hooks that need the final assistant text of the current turn should
> use `last_assistant_message` on Stop and SubagentStop instead of reading the transcript

Line 2196, Stop section:

> The `last_assistant_message` field contains the text content of Claude's final response, so hooks
> can access it without parsing the transcript file. For hooks that act on the just-completed turn,
> such as read-aloud or notification hooks, use this field rather than reading `transcript_path`:
> the transcript file isn't guaranteed to include the final message at Stop time on all versions.

This is the seventh change in one area. Six prior fixes — mt#2255 (boundary lines), mt#2357
(skill-body boundaries), mt#2824 (synthetic-interrupt exclusion), mt#3003 (stale-turn dedup),
mt#3273 (elision), mt#3280 (window anchoring) — and five of the six corrected _how the turn window
is computed from a file the vendor documents as possibly-stale_. The recurrence, not any single
bug, is the argument that the substrate needed deciding rather than the arithmetic needing another
patch.

### What the family actually is

All eleven `extractLastAssistantTurn` callers register on `UserPromptSubmit`; none registers on
`Stop`. Classified by the symbol each one's run path uses:

| #   | Module                                     | Symbol evidence                                                                                | Verdict                                                                                                                                                                      |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `wall-of-text-detector.ts`                 | `extractFinalAssistantText(turnLines)` only — the last assistant line carrying text            | text-only **at the time of writing; see the mt#4531 amendment in §Status — it now reads every assistant text block in the turn, so the family has no text-only member left** |
| 2   | `causal-premise-detector.ts`               | `extractToolUseNames(turnLines)` → `hasToolBacking`                                            | tool-inspecting                                                                                                                                                              |
| 3   | `retrospective-trigger-scanner.ts`         | `hasRetrospectiveSkillInvocation` — scans `tool_use` blocks for `Skill{skill:"retrospective"}` | tool-inspecting                                                                                                                                                              |
| 4   | `substrate-bypass-detector.ts`             | `extractToolUseNames(turnLines)` → `hasExecution`                                              | tool-inspecting                                                                                                                                                              |
| 5   | `pre-narration-detector.ts`                | `extractWindowToolUseNames(lines, TRAILING_WINDOW_TURNS)` — a MULTI-turn window                | tool-inspecting                                                                                                                                                              |
| 6   | `ask-routing-deferral-detector.ts`         | `turnHasAsksCreate` → `extractToolUseNames`                                                    | tool-inspecting                                                                                                                                                              |
| 7   | `code-mechanism-assertion-detector.ts`     | read-class `tool_use` INPUTs + all `tool_result` CONTENT                                       | tool-inspecting                                                                                                                                                              |
| 8   | `constructed-identifier-batch-detector.ts` | `extractToolUseBlocksByMessage` — `tool_use` blocks grouped per assistant message              | tool-inspecting                                                                                                                                                              |
| 9   | `build-claim-injection-detector.ts`        | `findToolUseInputs` over file-edit + command tools; `*session_pr_merge` presence               | tool-inspecting                                                                                                                                                              |
| 10  | `silent-stretch-detector.ts`               | counts `tool_use` blocks per run AND reads per-line `timestamp`s                               | tool-inspecting                                                                                                                                                              |
| 11  | `operator-deferral-detector.ts`            | `findToolUseInputs(turnLines, "Bash"/"session_exec")` → `hasProbeEvidence`                     | tool-inspecting                                                                                                                                                              |

**Ten of eleven are tool-inspecting; exactly one is text-only.** `last_assistant_message` carries
assistant TEXT only, so it can fully serve exactly one module. Module 10 is the hardest case under
any option: it needs per-line timestamps, which `last_assistant_message` cannot supply at all.

### Two facts that constrain every option

- **`StopFailure` runs _instead of_ `Stop`** when a turn ends on an API error, and its "Output and
  exit code are ignored" (hooks.md ~line 2288). Anything that depends on `Stop` running silently
  loses every API-error turn.
- **`Stop` fires EARLIER in wall-clock than the next `UserPromptSubmit`** — the next prompt happens
  whenever the principal next types. The transcript file therefore has strictly _more_ flush time
  at prompt-submit than at Stop. Moving transcript reads to `Stop` makes the lag exposure worse,
  not better. What `Stop` buys is an unambiguous **anchor** (`extractFinalTurn`'s tail needs no
  second bounding prompt), not a more-complete file.

That second fact is the axis the decision actually turns on, and it inverts the naive reading of
the vendor guidance. The guidance is precisely scoped: use `last_assistant_message` _for the final
assistant text_. It says nothing that recommends reading tool calls earlier.

### The premise that had to be falsified first

The original framing held that detection must live at `UserPromptSubmit` because that is where a
hook's stdout reaches Claude's context. The stdout half is true (hooks.md line 674: the exceptions
are `UserPromptSubmit`, `UserPromptExpansion`, and `SessionStart`) — but stdout is not the only
injection channel, so the conclusion does not follow. `Stop` hooks inject via
`hookSpecificOutput.additionalContext` (hooks.md ~line 2270), and **Minsky already does this**:
`.minsky/hooks/dispatcher.ts:748-753` emits `{hookSpecificOutput: {hookEventName, additionalContext}}`
generically for every event, and two guidance detectors — `turn-end-retro-scan`,
`turn-end-untaken-action-scan` (`registry.ts:1329-1410`) — already inject at `Stop` today.

So Stop-side injection is available. The question is whether it is _desirable_, which is a
different question and is answered under `## The principal-facing axis`.

## Decision

**Assign each sub-operation to its best source. Anchor at `Stop`; detect and inject at
`UserPromptSubmit`.**

"Detect the just-completed turn" is not atomic. It is four separable sub-operations, and framing
the problem as "which event?" conflated them:

| Sub-operation                        | Best source                             | Where it goes                                                                                       |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| (1) locate the turn window           | transcript boundaries                   | **`Stop`** — the tail needs no second bounding prompt; this is where all six prior fixes were spent |
| (2) capture the final assistant TEXT | `last_assistant_message`                | **`Stop`** — handed over directly; the vendor's actual recommendation                               |
| (3) read the turn's TOOL CALLS       | transcript only — no alternative exists | **`UserPromptSubmit`** — strictly more flush time                                                   |
| (4) inject guidance                  | `hookSpecificOutput.additionalContext`  | **`UserPromptSubmit`** — unchanged; preserves today's attention model                               |

Concretely: a new `Stop`-side **recorder** persists the just-completed turn's stable boundary key
(the opening prompt line's `uuid`/`timestamp`) together with `last_assistant_message`. At the next
`UserPromptSubmit`, detectors slice the transcript against that **recorded** anchor instead of
re-deriving it, and use the recorded final text for (2).

Two pieces of this already exist and were built for exactly this purpose:

- `extractFinalTurn` (`.minsky/hooks/transcript.ts`) already returns the bounding prompt line
  alongside the turn, and its own doc comment states the reason: "so callers can key the turn
  stably (`uuid` / `timestamp`) across a later prompt-time re-scan of the same turn."
- `.minsky/hooks/turn-end-scan-store.ts` is the existing precedent for persisting state from a
  `Stop` guard to a later event.

**Degradation is the property that makes this safe.** When no anchor was recorded — `StopFailure`
on an API-error turn, a session that died without a `Stop`, a first run before the recorder ships —
prompt-time detection falls back to mt#3280's `resolveCompletedTurn`, i.e. to option (a) exactly as
it behaves today. This option cannot lose a turn relative to the status quo; it can only fail to
improve one.

### Options rejected

**(a) Keep detect-and-inject at `UserPromptSubmit` on mt#3280's resolver.** The status quo plus the
lag-tolerant resolver. Cost: the anchor is still _inferred_ from prompt boundaries every turn, which
is the exact computation six prior fixes were spent correcting. mt#3280 made the inference
lag-tolerant; it did not remove the inference. Rejected as insufficient, but retained as this
decision's **fallback path**, which is why it is not really "rejected" so much as demoted.
_Final turn of a conversation:_ not scanned by any prompt-time detector — covered only by the two
`Stop` guards. _API-error turn:_ scanned normally at the next prompt (no `Stop` dependency).

**(b) Detect at `Stop`, persist the finding, inject at the next `UserPromptSubmit`.** Rejected on
three counts. It reads tool calls at the moment of _least_ flush (see the second constraining fact).
It requires every one of the eleven detectors to split into a detect-half and an inject-half plus a
finding store — the largest migration of any option, for the worst input. And it inherits a leak:
a finding computed for a turn never followed by another prompt is persisted and never injected.
_Final turn:_ detected but never delivered. _API-error turn:_ lost entirely (`StopFailure`'s output
is ignored, so no finding is recorded).

**(c) Split by detector — text-only detectors move to `Stop`, tool-inspecting ones stay.** The
classification above resolves this empirically: it moves **exactly one module**
(`wall-of-text-detector`). That is not a middle path; it is option (a) with one exception, and it
buys a split codebase — two turn-resolution disciplines to keep in sync — for a single detector's
benefit. Rejected. (Under the chosen option, `wall-of-text-detector` gets the same benefit anyway:
the recorded `last_assistant_message` is exactly what `extractFinalAssistantText` is reconstructing.)
_Final turn:_ covered for the one moved detector, not for the other ten. _API-error turn:_ lost for
the one moved detector.

**(d) Detect AND inject at `Stop` via `hookSpecificOutput.additionalContext`.** The option the
falsified premise had ruled out, and the one that most looks like "just follow the vendor guidance."
Rejected on the attention model plus a live defect:

- Stop-time `additionalContext` does not ride along quietly with the principal's next prompt. Per
  hooks.md, it _continues the conversation_ so Claude can act on it, bounded by `stop_hook_active`
  and an 8-consecutive-continuation cap. Eleven advisory detectors each able to independently wake
  the agent and continue a turn is a materially different product, not a plumbing change.
- **mt#2005 is an open, unfixed defect on exactly this path** — "Stop-hook replay-without-rerun:
  cached block-reason re-injected across turn-end attempts." Migrating eleven detectors onto a
  known-broken injection path is not a trade this evidence supports.
- It still reads tool calls at the moment of least flush.

_Final turn:_ covered (this is option (d)'s one genuine advantage — it is the only option that
scans the last turn of a conversation with the full detector family). _API-error turn:_ lost
entirely.

### What the calibration data shows — and does not

The success criterion for this decision required grounding the lag comparison in observed data
rather than doc-reading. `.minsky/retrospective-trigger-calibration.jsonl` is the only natural A/B
available: the prompt-time `retrospective-trigger-scanner` and the Stop-time `turn-end-retro-scan`
write the _same_ log under `calibrationLog: "retrospective-trigger"`, and Stop-side records are
distinguishable by their `stop_hook_active` / `channel` fields.

As of 2026-07-31 the log holds 30 records: **23 prompt-side** (2026-05-24 → 2026-07-31) and
**7 Stop-side** (2026-07-21 → 2026-07-26, the Stop guard having shipped 2026-07-21 via mt#2357).
Restricted to the window where both surfaces were live (2026-07-21 onward), the same detector
family fired **7 times at `Stop` and once at `UserPromptSubmit`.**

**That 7:1 is suggestive, not decisive, and it must not be cited as a clean result.** Three
confounds, each sufficient on its own to explain it:

1. The window overlaps the mt#3280 mis-anchoring defect, which was live until 2026-07-29 and caused
   prompt-time detectors to scan the wrong turn. The comparison cannot separate "`Stop` is the
   better surface" from "the prompt-side was broken for most of the window."
2. The two surfaces have different suppression rules — the `Stop` guard is dedup-bounded to one
   continuation beat; the prompt-time scanner carries the mt#3003 stale-turn dedup.
3. n = 8 in-window.

What it does support is narrow and is the thing this ADR acts on: the prompt-side surface was
under-firing, and the cause was the _anchor_. The chosen option fixes the anchor without moving the
read or the injection. The honest measurement — a post-mt#3280, post-recorder comparison over a
window where both surfaces are healthy — is specified as the gate in `## Consequences`.

## The principal-facing axis

Options (b) and (d) change _when and how the principal receives guidance_: (b) delays a finding to
the next prompt with a leak on the final turn, and (d) converts eleven advisory reminders into
turn-continuations the agent acts on without the principal in the loop. Under
`principal-context.mdc`, the attention model is principal-reserved territory, and either of those
would have to be routed through an ask before this record could be Accepted.

The chosen option changes neither. Injection stays at `UserPromptSubmit`, one merged
`additionalContext` block, same budget, same priority ordering — byte-for-byte the same delivery the
principal sees today. Only the window the detectors measure changes. The ratification gate therefore
does not fire, and this ADR is Accepted without one. If a future phase revisits option (d), that
gate fires then.

## Consequences

**Positive.** Removes the inference that six of seven fixes in this area were spent correcting: the
turn boundary becomes _recorded_ rather than _re-derived_. Gives the one text-only detector the
vendor-recommended source for free. Preserves the maximum-flush read for the ten tool-inspecting
detectors, and preserves the principal's attention model exactly. Degrades to today's behavior
rather than to a gap.

**Negative / risks.** Adds a cross-event store — one more piece of state that can go stale, and a
new silent-failure surface if the recorder stops running (mitigated by the degradation path, which
makes recorder-absence indistinguishable from today rather than from broken). Does not solve the
final-turn coverage hole: the last turn of a conversation remains covered only by the two `Stop`
guards, as it is today. Option (d) is the only option that would close that hole, and it is rejected
on other grounds — so the hole is _retained deliberately_, not overlooked, and remains available as
a separate decision.

**Migration cost, concretely.** The eleven detectors' detection logic is **unchanged** — none of the
phrase lists, suppression rules, or calibration payloads move. The change is concentrated in three
places: `.minsky/hooks/transcript.ts` (accept a recorded anchor, fall back to `resolveCompletedTurn`
when absent), the shared guard-context resolution that already loads transcript candidates once per
dispatch (D6), and one new `Stop`-side recorder guard plus its store. Each of the eleven changes at
most its window-source call; several change nothing if the shared helper is swapped underneath them.

**Calibration-log schema and watermarks are unaffected.** No detector's log name or record shape
changes, so `calibration-review-watermarks.json` — which keys by log name — needs no migration. The
recorder is not a detector: it writes to an anchor store (sibling of `turn-end-scan-store.ts`), not
to a calibration log.

**Measurement gate for any further move.** Before any future phase reconsiders `Stop`-side detection
or injection, re-run the `retrospective-trigger` comparison over a window in which both surfaces are
healthy — post-mt#3280 and post-recorder — with the dedup asymmetry controlled for. The 7:1 above
does not clear that bar and must not be cited as if it does.

## Why this deviates from the vendor's stated guidance

hooks.md says hooks needing the final assistant text of the current turn should use
`last_assistant_message` on `Stop` rather than reading the transcript. **This decision follows that
guidance for what it actually covers and deviates for what it does not.**

- **Followed:** sub-operation (2). The final assistant text is captured from
  `last_assistant_message` at `Stop`, exactly as documented.
- **Deviation, with justification:** sub-operation (3). Ten of the eleven detectors need the turn's
  TOOL CALLS, and `last_assistant_message` does not carry them — the transcript is the only source
  that exists, so "read the transcript" is not a choice being made against the guidance, it is the
  only available implementation. Given that the transcript must be read, it is read at
  `UserPromptSubmit`, where the file has had the most time to flush, rather than at `Stop`, where it
  has had the least. Reading a possibly-lagging file _later_ is the lag-minimizing option, not a
  disregard of the warning.
- **Residual exposure, stated plainly:** the transcript may still lag at prompt-submit time. mt#3280's
  `resolveCompletedTurn` makes the window resolution tolerant of that lag rather than assuming a
  fixed prompt offset, and the recorded anchor removes the boundary inference entirely. Neither makes
  the file synchronous. A turn whose tool calls have not been flushed by the time the principal's
  next prompt lands is still under-scanned; no available mechanism closes that, because no
  non-transcript source for tool calls is exposed to hooks.

An agent reading `.minsky/hooks/transcript.ts` and wondering why detection reads a file the vendor
warns about should find that reasoning here rather than re-deriving it — which is what the doc-comment
pointer in that file exists for.

## References

- Task **mt#3292** (this decision); tactical predecessor **mt#3280** (lag-tolerant window resolver —
  required under every option, shipped independently, commit `fbdc12539`).
- **Implementation: mt#3490** — the `Stop`-side anchor recorder, its store, the `transcript.ts`
  window-resolution change and its fallback. This ADR decides; mt#3490 builds. Its acceptance tests
  are the test of this record's migration-cost claim.
- **ADR-024** — detection-mechanism ladder for the guidance-hook family (the mechanism axis; this
  ADR is its event-axis sibling). Task mt#2263.
- **ADR-028** — guard-hook dispatcher consolidation (D1 `dispatch-stop.ts`, D6 shared context
  resolution — the plumbing the recorder extends). Task mt#2357.
- Prior fixes in this area: mt#2255, mt#2357, mt#2824, mt#3003, mt#3273, mt#3280.
- **mt#2005** (TODO) — Stop-hook replay-without-rerun bug; the live defect that helps rule out
  option (d).
- **mt#3293** (PLANNING) — the orthogonal axis: WHICH transcript array the same eleven detectors
  read (flattened parent+subagent). Shares this decision's blast radius; coordinate on ordering.
- Vendor source: `https://code.claude.com/docs/en/hooks.md`, read as raw markdown 2026-07-29 —
  lines 632 (`transcript_path` lag), 674 (stdout-to-context events), 2048 (`agent_transcript_path`),
  2196 (`last_assistant_message`), ~2270 (`Stop` `additionalContext`), ~2288 (`StopFailure`).
- Existing precedents this decision builds on: `extractFinalTurn` and `resolveCompletedTurn`
  (`.minsky/hooks/transcript.ts`), `turn-end-scan-store.ts`, and the two shipped `Stop` guards
  `turn-end-retro-scan` / `turn-end-untaken-action-scan`.
