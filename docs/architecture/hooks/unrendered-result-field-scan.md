# `unrendered-result-field-scan` (mt#3913)

PreToolUse observer on `mcp__minsky__session_pr_create`. Log-only, fail-open, never denies.

## What it does

Reads the branch's diff against its merge-base with `main` and reports counter/flag fields the diff
ADDS to an exported `*Result` interface that nothing renders.

A field counts as **rendered** when its name appears in a string / template / array literal that is
**not inside a logger call**. Referenced only inside logger calls, or not at all, it is
plumbed-but-unrendered.

Diff-only: no corpus query, no database.

## Why a log call is not a render site

This is the whole discrimination, and the obvious rule gets it backwards.

mt#3514 added `orphansDeleted` and `orphanDeleteFailed` to `WriteTurnsResult`, threaded them into
`ExtractAllTurnsResult`, and shipped with no output site rendering either. Typecheck passed (the
types line up). Tests passed — `expect(result.orphansDeleted).toBe(3)` is exactly the assertion a
never-rendered field satisfies. Two reviewer rounds passed. Every one of those gates measures
whether the field is CORRECT; none can tell that from whether a human can SEE it.

The cost landed an hour later: the orphan DELETE silently failed to fire and the command printed an
ordinary success line, because the two fields built to report that condition were never surfaced
(mt#3911). The diagnosis had to be rebuilt from raw SQL.

The task was originally specified with the rule _"flag it if the name appears in no string literal,
template literal, **or log call**"_. Run against the real fixture, that rule **misses
`orphansDeleted`** — whose only literal reference is inside

```ts
logSink.warn(
  `writeTurnsForTranscript: removed ${orphansDeleted} orphaned turn row(s) for ` + …,
  { agentSessionId, orphansDeleted, currentTurnCount: turns.length }
);
```

— while correctly flagging its sibling `orphanDeleteFailed` (no literal references at all). It would
have half-passed its own regression fixture, missing the field the incident actually turned on, and
done so silently. The incident IS "it was logged somewhere nobody was reading while the command
printed success", so crediting a log as a render reproduces the defect inside the detector.

## Two things the real diff broke that a hand-written one would not have

1. **The interface name lives in the hunk header.** For a field added to an EXISTING interface, git's
   `@@ … @@ export interface WriteTurnsResult {` section heading is the only place the interface
   name appears in the whole diff. An earlier cut reset interface tracking on every `@@` line, so no
   added field was ever attributed to an owner and the detector reported nothing — silently, since
   "no owner" and "no fields" are indistinguishable downstream.
2. **The logger call is multi-line.** The call opens on one line and the field appears on two more,
   so a per-line test cannot see it. Paren depth is tracked from the opening line until it balances.

Both were found by running the check against `fae568fbe`'s actual diff rather than a reduced
fixture, which is the same lesson mt#3959 recorded one task earlier.

**Negative control:** with the hunk-header handling reverted, 4 of 11 tests fail, including both
mt#3514 fixture assertions.

## Scope

Deliberately narrow — a low-false-positive slice, not full coverage of "observability nobody can
see":

- Only exported interfaces whose name ends in `Result`.
- Only `number` / `boolean` fields (the counter and flag shapes).
- Test files excluded.
- A field added to a non-`*Result` type is out of scope by construction — mt#3514's own
  `WriteOutcomeClassification` gains the same field and is correctly ignored.

## Posture

Log-only, because the mechanical proxy ("does anything print it?") stands in for an undecidable
question ("was this meant to be visible?"), and errs toward flagging internal-only fields. Every
evaluation is recorded, fired or not, so the MISS rate is measurable rather than only the fire count
— a fire-only log cannot support a rung decision. Fail-open: a missed unrendered field is cheaper
than a blocked `session_pr_create`.

## Wiring

Registered on `session_pr_create`, which became a dispatcher-spawning tool in mt#3959. The
dispatcher's timeout in `.claude/settings.json` is DERIVED from the guards on that matcher —
`stale-signal-sweep` (18s) + this scan (12s) + a 5s margin = 35s. Re-derive it when adding another.

The registry entry lives in its own module for the same reason its sibling's does: `registry.ts` is
at the 1500-line `max-lines` ceiling. This is the second guard to take that route, which is the
recurrence mt#4115 predicted; that task splits `GUARD_REGISTRY` per family and deletes both
one-entry modules.

## Override

`MINSKY_SKIP_UNRENDERED_RESULT_FIELD_SCAN=1` (registered in `HOOK_ONLY_ENV_VARS`).

## Cross-references

`.minsky/hooks/unrendered-result-fields.ts` (pure core) ·
`.minsky/hooks/unrendered-result-field-scan.ts` (shell) · `stale-signal-sweep.md` (the sibling
defect: a field rendered under a WRONG name, vs this one's rendered NOWHERE — the two share the
`literalSpans` primitive) · mt#3514 (originating incident) · mt#3911 (the fix that surfaced the
fields) · mem#704 (a probe that cannot discriminate is not verification) · mem#922 · mt#2544
(family anchor).
