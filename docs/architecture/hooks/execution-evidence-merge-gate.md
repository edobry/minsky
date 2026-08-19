# Execution-Evidence Merge Gate

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620 doc-index convention; back-filled
> mt#3052). The compiled rule corpus carries only a terse index entry; this file is the durable
> detail, matching the sibling pattern used by every other guard hook.

PreToolUse on `session_pr_merge`: blocks a merge adding new **test files** or **operational
scripts** (`scripts/*.ts`) without an `Execution evidence:` block; dual-mode scripts need EACH
branch exercised. Hook: `require-execution-evidence-before-merge.ts`. Override:
`[unverified-tests]` title tag + follow-up task. Fail: open on unresolvable repo/PR or `gh`
failure. Siblings: `/prepare-pr` §1b, `/implement-task` §7a.

## AT-cross-reference trigger (mt#3033, calibration-first)

ADDITIVE third path, independent of the file-pattern triggers above (which remain the
unchanged, deterministic BLOCKING floor): resolves the bound task's `## Acceptance Tests` (via
`minsky tasks spec get <task> --json`), classifies each AT executable-vs-findings-shaped (skips
`state-ops`-kind tasks and findings-shaped text like "audit produces…" / "decision recorded…"),
and checks whether the `Execution evidence:` block addresses each executable AT by
number/keyword or an explicit `[atN-deferred: mt#NNNN]` marker.

Per the mt#2263 calibration ladder this ships **LOG-ONLY** (v1): an unaddressed AT appends a
record to `.minsky/execution-evidence-at-coverage-calibration.jsonl` and surfaces a WARN via
`additionalContext` — it never emits `permissionDecision: "deny"`; graduating to blocking is
tracked as mt#3059 (flip WARN -> deny once the calibration FP rate is measured) — mt#3033 ships
Phase 1 (log-only) only.

Override: `MINSKY_SKIP_AT_COVERAGE=1`. Fail: silent (no WARN) on any task-spec fetch/parse
error.

**Root incident:** mt#2542 (PR #2136 merged with proxy evidence while the spec's literal AT —
"services boot on the role" — was silently deferred and crashed production post-merge).

### The absent-vs-present-elsewhere partition (mt#3339, FP-4)

An unaddressed AT is additionally CLASSIFIED into one of two kinds, recorded as
`presentElsewhereAts` on `AtCoverageResult` and on the calibration record:

- **absent** — the AT's number appears nowhere in the PR body. A real coverage gap.
- **present-elsewhere** — the number IS referenced in the body, just not inside the block the
  scanner reads. A LOCATION gap: the author documented it, under a heading the extractor has
  no notion of (`## Testing`, `## Design/Approach`, …).

The two were previously indistinguishable, which made the flagged count uninterpretable — the
mt#3316 `--full` re-measurement reported "N of M pairs still flagged" with no way to tell how
many were real. That count is the input to mt#3059's 0-known-FP graduation bar, so partitioning
it is a precondition for the graduation decision rather than a reporting nicety.

**The probe is number-reference-only, deliberately.** Running the KEYWORD matcher over a whole
PR body would be near-certainly all-positive (a body reliably mentions its own subject matter,
and any ≥5-char non-stopword token counts), classifying substantially everything as a location
gap and carrying no signal.

**Log-only, and it does NOT widen the scan.** A present-elsewhere AT is still counted
unaddressed and still warned about; nothing branches on the field. Accepting these locations as
evidence is a separate decision that this partition exists to inform, because widening carries
a false-negative risk — an AT number named in a `### Does NOT cover` bullet is not evidence.
Mirrored on the success-criteria surface as `presentElsewhereCriteria`; `scripts/at-coverage-reclassify.ts --full`
reports the split. Precedent: `negativeControlUnmatched` (mt#3511, `test-first-evidence.ts`).

## Cross-references

- mt#1459 — the original execution-evidence gate (test-file / script surface)
- mt#3033 — the AT-cross-reference addition (this doc)
- mt#3059 — tracked graduation from log-only WARN to blocking deny
- mt#2542 — root incident motivating both the original gate and this extension
- `/prepare-pr` §1b, `/implement-task` §7a — the paired preventive-phase skill steps

## Success-criteria cross-reference (mt#3350, calibration-first)

A FOURTH path, independent of the file-pattern triggers and of the AT cross-reference above.
It reads the bound task's `## Success Criteria` — a section that, until mt#3350, was
cross-referenced by **nothing**. `validate-task-spec.ts` checked the heading's PRESENCE at
creation time and `task-prompt-generation.ts` checked `spec.includes("Success Criteria")` for a
checklist table; no gate ever read the content.

Implementation: `.minsky/hooks/success-criteria-coverage.ts`, called from this gate's entry
point. It reuses the spec markdown the AT run already fetched, so it adds **no** CLI call per
merge, and it shares `markdown-sections.ts`'s fence-aware scanning rather than re-deriving it.

### The classifier default is INVERTED, deliberately

`isExecutableAcceptanceTest` treats every AT as executable and SUBTRACTS findings-shaped text.
`isExecutableSuccessCriterion` does the opposite: it requires a POSITIVE match, and requires
**both halves** — a command shape (a backticked or bare `grep`/`rg`/`wc`/`find`, a `$ <cmd>`
line) AND an expected-result shape ("returns zero hits", "the count is N", "exit code 0",
"is empty").

The conjunction is load-bearing (PR #2432 R1). The first implementation treated the two
families as alternatives, so a bare `$ bun test` — a command with no stated expected outcome —
classified as executable. That contradicts the premise: the point is that such a criterion IS
ITS OWN CHECK, and a command with no expected result cannot settle anything by being run. The
reviewer flagged the `$ <cmd>` case; the backticked-command shape had the same gap and was
fixed with it.

The inversion itself is the other half of the design. An `## Acceptance Tests` list is
behavioral by construction; a `## Success Criteria` list is mostly judgment prose ("the control
renders with cockpit surface tokens"), with the executable ones a sharp minority. Inheriting
the AT default would flag nearly every criterion and bury the real signal — the mem#719 failure
mode, where a detector's unmatchable output trains readers to discount its correct output too.
Under-flagging is the safe direction while this ships log-only; the calibration log is how the
pattern set widens on evidence.

### What counts as addressing a criterion

Any one of: a `[scN-deferred: mt#NNNN]` marker for that criterion number; a dedicated `SC<N>`
heading section in the PR body; a by-number reference in the evidence block (`SC3`,
`criterion 3`); or a distinctive keyword shared with the criterion's text.

The deferral marker is **per-criterion and numbered**, mirroring `[atN-deferred:]`. A bare
`[sc-deferred: ...]` — which mt#3350's own first spec draft proposed — cannot target one
criterion, so a single marker would excuse an entire list. That is precisely the "prose
explaining the skip reads as coverage to a human and as nothing to the gate" failure the marker
convention exists to prevent.

### Being addressed is not the same as agreeing (mt#4214)

The four tests above answer whether a criterion was REFERENCED. They compare nothing, so a PR
that names the criterion AND pastes the command's real output clears every one of them while the
output says the opposite of what the criterion asks for. mt#4214 adds the agreement half.

**Both sides read counts through ONE shared list.** `extractAssertedCount` reads the count a
criterion states; `extractReportedCount` reuses it for the evidence and adds the shape a
criterion never has — a lone bare integer on its own line, which is what `wc -l` and `grep -c`
print. Two hand-mirrored matchers would drift on every widening (mt#4070's shape).

**The capture list is a strict SUBSET of the classifier's expected-result patterns** —
`returns zero|no|N <unit>`, `the count is N`, `zero|0 <unit>`. It adds none: widening the
classifier changes which criteria the surface considers executable, and therefore the population
every calibration record is drawn from. `exit code 0` and `is empty` ARE classifier shapes and
are not counts, so they land as `not-comparable`.

**Attribution is bounded, and keyword association is not a basis for it.** The region whose
number belongs to a criterion is (1) a dedicated `SC<N>` heading section, else (2) the evidence
lines referencing it by number plus the block beneath, stopping at a blank line or a different
criterion's number, else null. Keyword overlap — the loosest of the four presence tests — is
excluded deliberately: it is where a wrong pairing would come from, and a confident false
disagreement costs more than no check (mem#719). More than one bare integer in a region reads as
null for the same reason. The terminator recognizes ALL FOUR written reference forms (`SC2`,
`success criterion 2`, `criterion 2`, `sc-2`) from the same list the region STARTER uses; PR
#3082 R1 caught them as two hand-mirrored lists, where an adjacent `Criterion 2:` line with no
blank line before it bled into the previous criterion's region.

**What it emits.** A disagreement produces a WARN naming `asks for N, evidence reports M`, and a
calibration record; agreement produces nothing at all. The record carries `findingClasses`
(`unreferenced` / `disagrees`), `disagreeingCriteria` (number, text, expected, actual) and
`notComparableCriterionCount`. The classes are separated so `/calibration-review` can rate them
independently — their remedies differ ("run the command" versus "the output contradicts the
criterion"), so a shared FP rate over both would be uninterpretable. Posture is unchanged:
log-only, never a merge block.

**The limit, measured.** mt#4076 / PR #3047 motivated the change and is not caught by it. Its
criterion — `returns one hit per subcommand action` — matches no expected-result pattern at all,
so it is not classified executable and the surface reports `applicable: false`. The instance sits
outside this check's POPULATION, not merely outside its comparable subset; a test pins that.

### `SC<N>` heading recognition is this task's half of FP-4

mt#3339 owns the general FP-4 fix (evidence under non-canonical headings such as `## Testing`
or `## Design/Approach`). `SC<N>`-shaped headings are carved out to mt#3350 by explicit
agreement recorded in both specs, because mt#3350 is what DEFINES what an SC number means —
recognizing the shape before that convention existed would be guessing at a numbering nothing
produced. The real-world instance is mt#3149 / PR #2255, whose body carries
`## SC3 (...) — re-verified, closed as already-resolved`.

Matching is on the HEADING rather than by folding the section into the evidence text:
`collectHeadingSections` collects from AFTER the heading line, so the number — the only part
identifying WHICH criterion the section addresses — would otherwise be dropped.

### Injection half

`.minsky/hooks/inject-success-criteria.ts`, PreToolUse on `session_pr_create`, emits the
criteria verbatim into `additionalContext`. Registered as its own matcher block; the existing
`session_pr_create` PreToolUse blocks are multi-tool matchers that also cover `session_commit`,
and injecting on every commit would be noise.

Known limit, recorded rather than discovered later: PreToolUse fires with the create call
already in flight, so the injection cannot shape the body being submitted — it prompts a
follow-up `session_pr_edit`. The merge-time half above is the backstop that makes that
acceptable.

Override: `MINSKY_SKIP_SC_COVERAGE=1` (merge-time half). Calibration log:
`.minsky/execution-evidence-sc-coverage-calibration.jsonl`. Originating incident: mt#3347,
whose headline criterion — a one-line grep — was authored by the agent 40 minutes before
implementation, never run, and shipped past clean typecheck, clean lint and 1487 passing tests
with the exact control the principal had screenshotted still unmigrated. See mem#736.

## Task-id resolution (mt#3355)

This gate resolves its task id through the shared `merge-gate-task-resolution.ts` module, which
prefers `tool_input.task`, falls back to the `task/mt-<id>` branch in `cwd`, and WARNS rather
than silently allowing when neither resolves. See
[Merge-Gate Task Resolution](./merge-gate-task-resolution.md).
