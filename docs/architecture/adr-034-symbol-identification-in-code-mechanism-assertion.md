# ADR-034: Symbol identification in `code-mechanism-assertion` stays shape-based

## Status

Accepted — 2026-08-01. Decided under mt#3549.

**REOPENED — 2026-08-27, under mt#4650.** Reopen condition 2 (measured FP rate above 10%) has
fired: two classified windows at 73% and 77%. The Decision below stands as the record of what was
chosen and why, and is NOT yet superseded — the replacement disposition is a principal decision,
open at ask#10657. See `## Reopened` below for what the reopen does and does not license.

## Context

`code-mechanism-assertion` fires when an agent asserts how a code mechanism behaves without having
read it that turn. To do that it must first decide, for each token in the assertion, whether the
token names a code mechanism at all. `isPlausibleSymbol`
(`.minsky/hooks/code-mechanism-assertion-detector.ts`) answers that by SHAPE — camelCase,
snake_case, backticked, path-like — minus a list of shapes that look like symbols but are not.
(Named, not line-anchored: this ADR's own doc-comment addition to that function shifted the line
it would have cited, which is the drift a line number in a durable record buys.)

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

## Reopened — 2026-08-27 (mt#4650)

### Condition 2 fired

| Window     | Injected | Classified false | FP rate |
| ---------- | -------- | ---------------- | ------- |
| 2026-08-21 | 11       | 8                | **73%** |
| 2026-08-26 | 13       | 10               | **77%** |

Both from `/calibration-review` passes over
`.minsky/code-mechanism-assertion-calibration.jsonl` — the measurement surface this ADR's own
`## Consequences` names ("its FP rate is re-measured every sweep"). The bar is 10%; both windows sit
~7x over it.

**The "after the current exclusions" qualifier was checked, not assumed.** The newest exclusion is
mt#4387's symbol-equals-its-own-predicate filter (`isArtifactPair`), merged `a28fa81e7` at
2026-08-26T23:46Z — after both review watermarks (the 2026-08-26 sweep's sits at log line 1302,
2026-08-26T21:37:44Z). Across every injected claim from 2026-08-21 to 2026-08-27T01:00Z exactly ONE
has symbol == predicate (`raise / raise`, 2026-08-26T22:58Z), and it falls after that watermark. So
the newest exclusion removes zero claims from either classified window and neither figure moves.

**The other two conditions did NOT fire, and should not be cited.** Condition 1 (two exclusion
rounds inside 5 days): round 6 is mt#4157, 2026-08-16 — 10 days before the filing. Condition 3 (a
repo-wide identifier index existing for another reason): mt#3334 is DONE but ships guard/calibration
stream ingest, not an identifier index, and an exact grep over `src`/`packages`/`scripts`/`.minsky`
for `symbolIndex` / `SymbolIndex` / `identifierIndex` / `IdentifierIndex` / `buildSymbolIndex` /
`exportedSymbols` returns zero files. `ts-morph` is a dependency; nothing builds an index from it.
This reproduces mt#3549's `## Premise correction` 26 days on.

### What the reopen does NOT license — the rate is detector-level, this ADR is not

Condition 2 is written in terms of "the current mechanism failing its own bar", and the mechanism
this ADR governs is exactly one sub-operation: symbol ADMISSION (`isPlausibleSymbol`). The measured
73–77% is a DETECTOR-level rate. Attributing it to admission is an inference, and measurement does
not support it.

`buildClaims` runs five separable sub-operations, and only (3) is this ADR's:

1. match a predicate from `PREDICATE_PATTERNS` against the prose
2. collect symbols within `SYMBOL_PROXIMITY_CHARS` (= **100 characters**) of that match
3. admit/reject each by SHAPE — `isPlausibleSymbol`, **this ADR's surface**
4. pair symbol with predicate; drop artifact pairs (`isArtifactPair`, mt#4387)
5. decide backing / suppression

Attribution over the 45 injected claims from 2026-08-21 to 2026-08-27T01:00Z, reproducible via
`bun scripts/measure-cma-fp-attribution.ts` (38 distinct symbols; buckets OVERLAP, so they do not
sum):

| Bucket                                 | Sub-op                   | Count       |
| -------------------------------------- | ------------------------ | ----------- |
| symbol not in repo                     | (3) admission            | 9           |
| predicate crosses a sentence boundary  | (2)/(4) pairing          | 9           |
| symbol == predicate                    | (4) artifact, shipped    | 1           |
| **explained by ≥1 structural bucket**  |                          | **17 / 45** |
| **residue: in-repo AND same-sentence** | (1)/(5) or true positive | **28 / 45** |

Two readings follow, and both cut against a symbol-admission fix:

- **Admission is a minority contributor, and its bucket is not all error.**
  `pg_stat_statements_reset` is a Postgres function and `MouseExitDelay` a third-party config key —
  the "Third-party API surface" row of the measurement table above, which this ADR deliberately
  keeps IN scope. Subtract those and admission's real error share falls further.
- **Pairing is the same size as admission, and is fixable.** Sub-operation (2) collects any symbol
  within 100 characters, which routinely reaches across a sentence boundary — `environment.ts`
  paired with a `drop` from the following sentence, `O_CREAT`/`O_EXCL` with an `overwrites` belonging
  to `rename`. **mt#4675** owns it, with a sentence-scoped filter measured to remove 9 of 45 and lose
  none of the known positives. (The stricter clause-scoped variant was measured and DECLINED by
  mt#4387 because it lost `pr_watch / returns`.)

### The allowlist rejection reproduces — now from the converse direction

The Decision above rejected the repo-symbol allowlist because the TRUE positives are not in a TS
index. Re-measuring on a 2026-08-27 corpus, with a membership test far broader than a TS index
(content search across `src`/`packages`/`scripts`/`.minsky/hooks`), reproduces that and adds the
other half:

**10 of 45 claims are a bare lowercase word — and 10 of 10 score IN-REPO.**
`unless`, `minsky`, `git`, `license`, `driver`, `feeds`, `rename`, `raise`, `workspace`.

Neither discriminator separates this class. Shape cannot, because `driver` and `unless` are the same
shape. Membership cannot either — and it is worse than inert here, because an ordinary English word
appears somewhere under the repo roots essentially always, so it returns a confident "member" for
precisely the tokens least likely to name a mechanism. The class contains a known TRUE positive
(`driver`, a real Minsky concept) alongside obvious falses (`unless`, `license`, `workspace`).

So consequence 1 of the Decision above — _"Coverage converges back on shape-matching"_ — now has a
second, independent line of evidence, from a different corpus 26 days later, running in the opposite
direction. **Do not re-propose the allowlist without engaging this measurement.**

### Disposition — open, and the principal's

Per the accepted RFC _The evaluation loop — auditing the regulators_
(Notion `392937f0-3cb4-8188-aad6-d7d041de814b`, Accepted 2026-07-08 via ask `54334d49`), a guard
exceeding its false-positive budget across consecutive reviews **requires a disposition decision**
from {retire, consolidate, tune, affirm}, with _"affirm-by-default not among the allowed
responses"_, packaged as an outlier in a principal-facing review. That is the record routing this
decision, not any ADR-ratification convention.

Open at **ask#10657**, with four options and a measurement behind each. The agent recommendation is
(a) consolidate — leave admission as decided and spend the effort on pairing and the residue —
on the attribution above.

**Match / extend / deviate:**

- Against **this ADR's own reasoning**: **EXTEND, not deviate.** The reopen ran the procedure this
  ADR wrote for itself, and the new measurement CONFIRMS its central finding rather than
  overturning it. What is new is scope: the ADR framed the FP rate as evidence about its own
  mechanism, and the rate turns out to be mostly about other sub-operations.
- Against the **evaluation-loop RFC**: **MATCH.** Its disposition set and its principal routing are
  adopted as written. Phase placement: the RFC's Phase 3 is where guard-level dispositions run; this
  one arrives out-of-band via this ADR's own reopen condition rather than via a scheduled
  rationalization review, and coordinates with that cadence rather than bypassing it.

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

Added by the 2026-08-27 reopen (mt#4650):

- mt#4650 — the reopen. Carries the planning audit, the attribution, and the corrected reading of
  what condition 2's measurement surface licenses.
- mt#4675 — predicate PAIRING, the sub-operation this ADR does not reach and which the attribution
  measures at the same size as admission.
- mt#4387 — round-6-adjacent tune that shipped `isArtifactPair` and measured the clause-scoped
  pairing variant as a negative result.
- `scripts/measure-cma-fp-attribution.ts` — the re-runnable attribution measurement.
- ask#10657 — the open disposition decision.
- RFC _The evaluation loop — auditing the regulators_
  (`https://app.notion.com/p/392937f03cb48188aad6d7d041de814b`, Accepted 2026-07-08) — defines the
  four dispositions and requires one when a guard exceeds its FP budget. Not in the in-repo ADR
  corpus, which is why the original filing's decision-record search did not reach it.
