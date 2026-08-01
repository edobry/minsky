# ADR-031: Symbol identification in `code-mechanism-assertion` stays shape-based

## Status

Accepted — 2026-08-01. Decided under mt#3549.

## Context

`code-mechanism-assertion` fires when an agent asserts how a code mechanism behaves without having
read it that turn. To do that it must first decide, for each token in the assertion, whether the
token names a code mechanism at all. `isPlausibleSymbol`
(`.minsky/hooks/code-mechanism-assertion-detector.ts:404`) answers that by SHAPE — camelCase,
snake_case, backticked, path-like — minus a list of shapes that look like symbols but are not.

That exclusion list has been extended five times, each round closing a class observed in
calibration data:

| Round | Task    | Excluded                                                                |
| ----- | ------- | ----------------------------------------------------------------------- |
| 1     | mt#3113 | generic English/tech words; bare single-segment dir refs                |
| 2     | mt#3002 | doc/config file extensions                                              |
| 3     | mt#3002 | bare hex commit ids                                                     |
| 4     | mt#3042 | UPPERCASE SQL/DDL keywords                                              |
| 5     | mt#3540 | timezones; product names; multi-segment dir paths; override boilerplate |

Every round was individually correct and evidence-backed, and the pattern is still an arms race on
the precision axis: the predicate can only exclude shapes someone has already watched fire.

mt#3549 proposed the reframe: the detector asks "does this token LOOK like a symbol?" when the
decidable question is "is this a symbol THIS REPO DEFINES?" — replace the exclusion list with an
allowlist keyed on real exported symbols, and every one of the five rounds becomes unnecessary
without anyone having to observe the class first.

**ADR-024 (detection-mechanism ladder) governs this detector family but does not reach this
decision.** Its three rungs — regex, embedding, learned-confirm — are about matching trigger
PHRASES: recall via paraphrase, precision via quotation-awareness. Symbol identification is a
different axis, which is why five rounds of shape exclusions accumulated without a rung to belong
to. This ADR names that axis and decides it; it does not amend the ladder.

## Decision

**Symbol identification stays shape-based. The repo-symbol allowlist is REJECTED as a gate.**

The proposal rests on a premise that measurement falsifies: that the identifiers these claims are
about are the identifiers a symbol index would contain.

### The measurement

Claimed symbols across the injected (non-suppressed) records in
`.minsky/code-mechanism-assertion-calibration.jsonl`, most recent 60 claims, by namespace:

| Namespace               | Examples                                                                               | In a TS export index?    |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------ |
| MCP tool names          | `transcripts_get`, `tasks_create`, `session_pr_create`, `session_exec`, `rules_get`    | **no**                   |
| Env vars                | `MINSKY_ACK_UNTAKEN_ACTION`, `MINSKY_COCKPIT_URL`, `MINSKY_SILENT_STRETCH_GAP_MINUTES` | **no**                   |
| File names              | `get-command.ts`, `turn-extractor.ts`, `memory-search.ts`                              | **no**                   |
| Guard / hook names      | `turn-end-untaken-action-scan`, `standalone-duplicate-matcher`                         | **no**                   |
| DB columns / SQL        | `transcript_lines`, `pg_column_size`                                                   | **no**                   |
| Third-party API surface | `requiresStrictStatusChecks`, `useChat`                                                | **no** (not this repo's) |
| TS exports              | `extractTurns`, `TaskService.getTasks`, `pendingAssistantBlocks`, `pushUnconfirmed`    | yes                      |

Only the last row survives an exported-symbol allowlist. The rest are real, repo-defined
identifiers that a TypeScript symbol index does not contain — and an assertion about how
`transcripts_get` behaves, or what `MINSKY_ACK_UNTAKEN_ACTION` overrides, is exactly the
unverified-mechanism claim this detector exists to catch. Gating on TS exports would convert a
large share of true positives into silent false negatives.

### Why the fix is not "index more namespaces"

Making the allowlist cover the observed namespaces means indexing TS exports ∪ MCP tool ids ∪
`MINSKY_*` env vars ∪ file paths ∪ guard names ∪ DB columns — six sources, each with its own
extraction and its own drift. Two consequences:

1. **Coverage converges back on shape-matching.** A union that broad admits nearly every
   identifier-shaped token the repo touches, so it stops discriminating — which is the job the
   exclusion list currently does.
2. **It buys a staleness surface for a problem measured at zero.** This is a `UserPromptSubmit`
   hook with an explicit per-invocation budget (`readHostCap` / `deriveBudgets`), so the index must
   be cached and invalidated. A stale index produces silent false negatives, and a detector that
   returns the same answer when it is broken as when it is healthy carries no information (mem#704;
   the mt#3393 / mt#3502 / mt#2057 incidents are all this shape). Meanwhile mt#3540's replay
   measured 7/7 known false positives silenced and 14/14 true positives retained — the current
   mechanism meets ADR-024's stated sufficiency bar today.

### Alternatives considered

- **Allowlist as a gate (the proposal).** Rejected above: the measurement shows most true-positive
  claims are about identifiers outside any TS symbol index.
- **Allowlist as a positive signal rather than a gate** — a token that IS a repo symbol fires with
  higher confidence, everything else falls back to shape-matching. Rejected as not solving the
  stated problem: the exclusion list exists precisely for the non-symbol path, so this retires none
  of the five rounds while adding the index and its staleness.
- **Rung 2 (embedding) for symbol identification**, by analogy to ADR-024's ladder. Rejected for
  now: the ladder's rungs address paraphrase recall, and the failure class here is precision on
  tokens whose SHAPE is unambiguous — an embedding does not tell a timezone from an identifier more
  reliably than a literal exclusion does, and mt#3408's Rung-2 nomination measured 0% precision on
  its own surface.
- **Accept the arms race explicitly** — the status quo, chosen here, with the reopen conditions
  below making it a decision rather than a drift.

## Consequences

- The five exclusion rounds STAY. They are correct under this mechanism, and mt#3549's `## Scope`
  already protected them from being reverted before a replacement was measured.
- A sixth round is now a decision with a record behind it, not a reflex: whoever proposes one
  should check it against the reopen conditions before writing another predicate.
- Recall stays as broad as shape-matching makes it, which is what keeps claims about MCP tools, env
  vars, guard names, and third-party APIs in scope.
- The precision cost is bounded by calibration review: the detector is LIVE, its records carry
  `suppressionReasons` (mt#3207), and its FP rate is re-measured every sweep.

### What would reopen this

Any ONE of:

1. **Two or more further exclusion rounds** (rounds 6 and 7) within a 5-day window — the cadence
   threshold from `decision-defaults.mdc §Thresholds`. That would show the arms race is accelerating
   rather than converging, which is the premise this ADR says is not yet true.
2. **A measured FP rate above 10% on a classified corpus** after the current exclusions — the
   current mechanism failing its own bar, rather than a theoretical objection to it.
3. **A repo-wide identifier index existing for another reason** — if some other task ships and
   maintains one (mt#3334's ingest thread is the plausible source), the cost side of this decision
   changes and the positive-signal variant becomes cheap enough to re-evaluate.

## References

- mt#3549 — this decision. Its `## Premise correction` records the falsified feasibility claim
  ("the codebase ships symbol-index machinery elsewhere" — it does not; `repo_search` is a ripgrep
  wrapper and `buildVerificationCorpus` reads content, not symbols).
- ADR-024 — the detection-mechanism ladder this detector family follows, whose scope does not reach
  symbol identification.
- mt#3113, mt#3002, mt#3042, mt#3540 — the five exclusion rounds.
- mt#3207 — `suppressionReasons` on this detector's records, which is what keeps its FP rate
  measurable at review cadence.
- mem#704 — a probe that returns the same result when the system is broken is not verification; the
  reason a cached index's staleness is treated as a cost rather than an implementation detail.
