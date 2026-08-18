# unowned-finding-scan

**Event:** `PostToolUse` on `mcp__minsky__tasks_status_set`
**Status:** log-only (calibration-first, ADR-024 ladder / mt#2263)
**Override:** `MINSKY_SKIP_UNOWNED_FINDING_SCAN`
**Task:** mt#4246

## What it catches

A task transitioning to **DONE** whose spec carries a findings section — `### Noticed, not
actioned` and its variants — containing an item that declares no owner.

The section is a good convention and this guard does not discourage it. An implementer who spots
something adjacent should write it down rather than silently widen scope. The defect is that the
convention has **no exit condition**: writing a finding into a spec section satisfies the letter of
`work-completion.mdc §Never notice an issue without acting on it` (it IS a spec update) while
producing exactly the outcome that rule exists to prevent — a real finding, recorded, with no
owner, in a task that is about to go DONE and stop being read.

## Why the existing guards could not see it

Three sibling guards cover adjacent shapes and all three are structurally blind here:

| Guard                          | Keys on                                  | Why it misses                                                                                  |
| ------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `turn-end-untaken-action-scan` | `last_assistant_message`                 | The finding was never in chat; it was in a `tasks_spec_patch` argument.                        |
| `turn-end-unwalked-task-scan`  | a `tasks_create` MINT                    | Nothing was minted — that is the failure.                                                      |
| `stop-at-decision-scan`        | a spec-patch into an OPEN non-bound task | The patch goes into the agent's OWN task, which its bound-task suppression correctly excludes. |

The finding is written into the one artifact none of them reads for this purpose.

## Ownership is a MARKER, not a reference

An item is discharged by one of two explicit markers, and by nothing else:

- `[owner: mt#4238]` — someone holds it.
- `[no-owner: one-line cleanup, no task warranted]` — deliberately unowned, with a stated reason.

**This is the guard's central design decision and it was made against a measurement, not a
preference.** The first draft discharged an item on any `mt#N`-shaped reference. That test cannot
distinguish a reference in OWNER position ("filed as mt#4238") from one in SUBJECT position
("mt#3130's build list is stale"), and the corpus turned out to be made entirely of the second
shape.

**The counts are stated at two points, because the guard changed between them.** When the reference
test was measured, the replay saw only LIST items and found **four**, across three specs — every one
carrying a reference in SUBJECT position and none declaring an owner. The reference test discharged
**4 of 4**, including both items from the originating incident: recall zero on the class it exists to
catch.

Widening to prose-bodied sections (below) then took the corpus to **six items across four specs**, of
which **five** carry a bare reference. The sixth — mt#3265's prose section — carries none and was
invisible to the list-only scan altogether.

Do not collapse these into one figure. An earlier draft of this page said "all six carried a bare
reference … discharged 6 of 6", which overstates both: the reference test never saw the sixth item,
and that item has no reference to discharge on (PR #3098 R4).

Widening the pattern (`filed as|tracked by|owned by`) is the obvious next move and is the wrong
one: that is a phrase corpus over free text, which ADR-024 assigns to Rung 2 and whose recall arms
race that ADR exists to end. A marker moves the judgment to the author, where it belongs — the
guard checks that ownership was **declared**, never infers it. Same construction the
execution-evidence gate already teaches with `[scN-deferred: mt#NNNN]`.

The cost is honest and is the point: **an item whose owner exists but is not declared in the spec
still fires.** mt#3845's first item is the sharpest case — it WAS actioned (mt#4238 was filed for
it) and its text said only "it needs a follow-up task filed once #3078 merges". A reader of that
record could not tell it was owned. That is the defect this guard is named for, not a false
positive.

A bare reference is still recorded on each finding as `bareRefPresent`, so a later calibration
review can measure how often one appears without re-running the corpus.

## A prose-bodied section counts as one finding

If a findings section contains no list items, its prose is treated as a single item. This is not a
widening for its own sake: mt#4228's real section (`## The third guard, recorded not fixed`) is
four paragraphs, an undischarged conditional — "file separately if the measurement justifies it" —
and no bullet anywhere. A list-items-only reading would make "write the finding as a paragraph" a
complete evasion of a guard whose entire trigger is the heading above it. **The heading is the
structural trace; the bullet is formatting.**

Distinct from the limitation the task accepts: a loose sentence in `## Outcome` under **no**
findings heading stays invisible, because there is no structural trace to key on. Reading all
outcome prose for "is this a finding with no owner" would be a semantic judgment, not a check.

Fenced code blocks are skipped, so a `#` line inside sample output cannot open or close a section,
and a section's own transcript excerpts do not become its finding text.

## How it decides

1. The tool must be `mcp__minsky__tasks_status_set` and the resulting status **DONE**. Status is
   read case-insensitively, and from the tool response when absent from the input.
2. The spec is read via the CLI (`minsky tasks spec get <id> --json`), budgeted at 20s.
3. Headings are matched case-insensitively at any depth against the findings patterns. The pattern
   deliberately **over-matches and the reading is precise** — a heading like `## Required actions
resolved` is a RECORD of discharge, not owed work, and is excluded by the discharge patterns
   checked first.
4. Each top-level list item (continuation lines folded in) is checked for the two markers. A
   section with no list items contributes its prose as one item.

It **fails open**: an unreadable spec, a missing task id, or a failed transition all record
nothing rather than guessing.

### Why PostToolUse

Deviates from the task spec's "Stop/PreToolUse" wording, recorded per the spec-decision
reconciliation discipline. The guard never denies, so PreToolUse buys nothing; PostToolUse
additionally means a FAILED transition writes no record, and it matches the sibling already keyed
on this tool+status axis (`drive-ready-to-implementation.ts`, PostToolUse on → READY).

Deliberately NOT hosted inside `tasks-status-set-guard.ts`, which is a DENY-tier state-machine
validator — folding a calibration-first advisory into a deny-tier guard would mix intervention
types in one file and put an unproven check on a blocking path.

## Measured rate

`scripts/replay-unowned-findings.ts` scans every spec through the persistence provider in one
query. Run 2026-08-18 over **4,128 specs**: **6 unowned items across 4 tasks** (mt#3845 ×2,
mt#4220 ×2, mt#4228, mt#3265), **5 of 6 carrying a bare reference**.

Hand-classification: **6 true positives, 0 false positives.** Two were genuinely unowned live
findings that nothing was tracking — a dead `COCKPIT_PALETTE_EXEMPT_FILES` entry (filed as mt#4254)
and 23 `driven_sessions` rows stuck non-terminal (filed as mt#4255, up from the 2 the record
claimed). The other four had owners that the record did not name. All six were discharged with
markers, and a re-run reports zero.

The replay was originally written to shell out to `minsky tasks spec get` once per task. At ~0.8s
of bun startup apiece it could not finish more than ~150 specs inside a tool timeout, and the 150 it
reached returned **zero** — a sampling artifact that reads exactly like a real zero. **A sampled
replay of a rare pattern measures the sampler, not the pattern.**

## Scope

The posture stays log-only. mt#4246 explicitly scopes flipping it out of calibration-first as out,
and a 6-item corpus is too small a base to justify injecting on. The number that would change this
is the rate of NEW fires per week once the marker convention is in use, not the one-time backlog.

## Registration — six sites, not five

Recorded because this task's own planning gate enumerated **five** and CI caught the sixth. A new
STANDALONE hook (one registered directly in `.claude/settings.json` rather than through the ADR-028
dispatcher) must be added to all of:

1. `.claude/settings.json` — the hook command itself.
2. `.minsky/hooks/known-guard-names.ts` → `STANDALONE_GUARD_NAMES`.
3. `.minsky/hooks/interceptor-descriptions-settings.ts` — the settings-stratum description map.
   (Dispatcher-registered guards go in `interceptor-descriptions.ts` instead; picking the wrong one
   fails `interceptor-descriptions.test.ts` AT2, a population check over every distinct `guardName`.)
4. `.minsky/hooks/interceptor-coordinates.ts` — for a log-only detector, `structuralRecorder`
   (`record`/`review`), NOT `conditionalFeeder`, which declares an `inject` intervention this guard
   never performs.
5. The override env var, in BOTH `.minsky/hooks/known-override-env-vars.ts` and
   `packages/domain/src/configuration/sources/environment.ts`'s `HOOK_ONLY_ENV_VAR_CATEGORIES`.
6. **`packages/domain/src/rules/enforcement-mapping.ts`** → `NON_ENFORCEMENT_CLAUDE_HOOKS`, with a
   stated reason. This is the one that is easy to miss: it lives outside `.minsky/hooks/` entirely,
   in the domain package, and its parity test asserts that **every** hook in `settings.json` is
   either an enforcement mapping or an explicitly-reasoned non-enforcement entry.

Site 6 is not reachable by pattern-matching a sibling hook's registration, because the sibling's
entry is in a different package from everything else you touch. `bun run test` catches it;
`bun test ./.minsky/hooks/` does not — this guard's whole hooks suite passed 5,530/0 with site 6
missing.

## Testing

`.minsky/hooks/unowned-finding-scan.test.ts` — 30 tests. The load-bearing ones:

- Every heading variant asserted **per-variant**, not by one representative.
- A reference in subject position **fires** (the regression that the marker exists to prevent).
- The real corpus items as verbatim fixtures, asserting all five fire and that four carry a bare
  reference — grounded in the exhaustive scan rather than in recall.
- The same items with markers added, asserting silence, so the adoption cost is demonstrated.
- A prose-bodied section, and a section whose preamble prose must not double-count against its own
  bullets.
- **Fence tracking is document-scoped** (PR #3098 R1): a findings heading quoted inside a fence
  OUTSIDE any section must not open one — the shape this guard's own documentation takes — plus the
  parity control that a real section after a closed fence is still detected.
- **A deeper subheading does not split a prose section** (PR #3098 R2), with the control that a
  same-level heading still closes it. Both controls exist because the obvious over-correction (never
  close on a heading) would pass the first test and break the boundary.

## Cross-references

- mt#4246 — this guard
- mt#4213 — the `## Success Criteria` sibling (prose explains, artifact stays wrong)
- mt#3831 — the CHAT surface of the same obligation
- `work-completion.mdc §Never notice an issue without acting on it` — the family root
- `docs/architecture/adr-042-gate-battery-enforcement-shape.md` — the structured-trace
  discriminator, applied here by analogy
- `docs/architecture/adr-024-*` — the detection-mechanism ladder that rules out the phrase corpus
