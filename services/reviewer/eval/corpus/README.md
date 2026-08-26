# Reviewer benchmark corpus

Committed inputs for the reviewer benchmark (mt#2726 Milestone A, mt#2746, mt#2991).

| File                     | What it is                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ground-truth-v1.jsonl`  | 374 mined rows across 174 PRs. Each carries a reviewer finding, its ±80-line code-context window, and a deterministic outcome label.            |
| `judge-verdicts-v1.json` | A **verbatim record of what a judge panel said** about the candidate rows, plus which rows were selected into the disagreement-weighted subset. |

## `judge-verdicts-v1.json` is a measurement record, not a reference document

This is the point most likely to be misread, and it has been misread at least once
(PR #3383 R1), so it is stated here rather than left implicit.

Every `rationale` string in this file is **raw model output, stored verbatim**. It is evidence
about what a specific model said on a specific date — not a claim the repository is making, and
not a document that is supposed to be internally consistent.

**Disagreement between judges is the signal this file exists to capture.** `agreement: false`
records it, and `findDisagreementWeightedSubset` (`../../src/judge.ts`) SELECTS on it: the
whole 76-row subset pushed for human labeling is the set of rows the panel could not settle.
Two judges giving contradictory accounts of the same code — including contradictory claims about
deterministic things like SQL `NULL` semantics, where one of them is simply wrong — is a row
doing exactly its job. `pr-1942-r1-f0` and `pr-1942-r3-f0` disagree about whether PostgreSQL's
`GREATEST()` propagates `NULL`; that disagreement is the datum.

**So do not edit, reconcile, or "neutralize" rationale text.** Rewriting model output to be
mutually consistent does not clean the corpus — it fabricates it, and it destroys the only
record of how the panel actually behaved. If a rationale is wrong, that is a measurement of the
model, which is what a benchmark is for.

**The rationales are never shown to human labelers.** `../../scripts/push-braintrust-gold-set.ts`
builds its payload field-by-field from an allowlist (`buildBlindDatasetRow`: `rowId`, `file`,
`severity`, `line`, `lineEnd`, `findingText`, `codeContext`) and never spreads a row; the key
sets are pinned by `push-braintrust-gold-set.test.ts`. No verdict and no rationale reaches the
labeling UI, deliberately — showing a labeler what the panel concluded would anchor the human
reference and inflate the very kappa the gold set exists to measure.

## `selectedIds` is load-bearing and must not be re-derived

The 76 ids in `selectedIds` are already pushed to Braintrust as dataset `reviewer-gold-set-v1`
and are what the human labeling pass labels (mt#4627). `findDisagreementWeightedSubset` derives
that subset FROM the verdicts, so **re-running the ordinary judge pass would select a different
76** and desync the repo from the labeling UI. Any operation on this file must leave
`selectedIds`, `disagreementCount`, `candidateCount`, `judgedCount` and `corpusVersion`
untouched.

## `contaminatedIds`

Rows where at least one judge call FAILED. This exists because a failed call is not visibly
failed: `judgeFinding`'s catch returns `verdict: "VALID"` — a legitimate `FindingVerdict` — with
the real cause in `parseError`, so a dead judge is indistinguishable from one that judged
`VALID` unless you look at that field. mt#4616 owns fixing that mechanism.

The bias is **directional, not random**: on the 2-member panel the fallback `VALID` pulls the
aggregate toward `VALID` through `aggregateVerdicts`' plurality rule. When mt#4633 repaired the
21 contaminated rows, 16 of their aggregates changed and every one moved AWAY from `VALID`.

Repair (needs judge-provider credentials; env-first, Minsky-config fallback):

```
bun services/reviewer/scripts/repair-judge-verdicts.ts --dry-run   # plan only, no network calls
bun services/reviewer/scripts/repair-judge-verdicts.ts             # re-run only the failed slots
```

It re-runs **only** the per-judge entries carrying a `parseError`, leaves every successful
verdict byte-identical, recomputes `aggregate`/`agreement` through the same `aggregateVerdicts`,
and rewrites `contaminatedIds` to whatever still fails. It is idempotent: with nothing
contaminated it makes zero calls and writes nothing.

## Consumers

- `../../scripts/run-judge-pass.ts` — produces the verdicts.
- `../../scripts/extract-judge-verdicts.ts` — projects a run artifact into the committed form.
- `../../scripts/repair-judge-verdicts.ts` — repairs contaminated rows (mt#4633).
- `../../scripts/score-human-labels.ts` — joins human labels by id and computes kappa; holds
  contaminated rows OUT of the statistic.
- `../../scripts/push-braintrust-gold-set.ts` — pushes the BLIND labeling set.
- `../../scripts/paired-eval-runner.ts` — replays challenger models over `ground-truth-v1.jsonl`.
