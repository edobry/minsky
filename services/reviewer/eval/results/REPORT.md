# minsky-reviewer on Martian's Code Review Bench (offline track) — mt#4577

**Read date:** 2026-08-25. **Pinned benchmark commit:**
[`2b092b670f7d6cae6d429babaaee18948b4bdacb`](https://github.com/withmartian/code-review-benchmark/tree/2b092b670f7d6cae6d429babaaee18948b4bdacb)
(see `../martian-bench/PIN.md` for the full reproduction procedure). **Judge model:**
`openai_gpt-5.2` — one of the three models the published leaderboard reports scores for
(`anthropic_claude-opus-4-5-20251101`, `anthropic_claude-sonnet-4-5-20250929`,
`openai_gpt-5.2`); **scores are not comparable across judges**, which is exactly why Martian
publishes per-judge results and why this report names one explicitly rather than blending them.

## Our score

| Metric       | Value     |
| ------------ | --------- |
| Precision    | 28.7%     |
| Recall       | 47.4%     |
| **F1**       | **35.7%** |
| PRs scored   | 50 / 50   |
| Judge errors | 0         |

Computed by the pinned checkout's own `step3_judge_comments.py`, unmodified — the same code
every vendor row below was scored by. Raw evidence: `gpt-5.2-judge/evaluations.json` (this
directory) carries the full per-PR true-positive/false-positive/false-negative breakdown.

## Beside the published leaderboard (same judge, same track)

Full 48-vendor table is reproducible from the pinned commit's own
`offline/results/openai_gpt-5.2/evaluations.json`
([source](https://github.com/withmartian/code-review-benchmark/blob/2b092b670f7d6cae6d429babaaee18948b4bdacb/offline/results/openai_gpt-5.2/evaluations.json),
read 2026-08-25). A representative subset — our named vendor set (per mt#4553's buy-vs-build
comparison) plus the two bracketing minsky's F1 on either side:

| Tool                | Precision | Recall    | F1        |
| ------------------- | --------- | --------- | --------- |
| Augment             | 50.8%     | 58.4%     | 54.3%     |
| Cursor Bugbot       | 52.8%     | 43.4%     | 47.6%     |
| CodeRabbit          | 30.7%     | 60.1%     | 40.6%     |
| Propel              | 45.0%     | 36.5%     | 40.3%     |
| Greptile            | 37.4%     | 38.0%     | 37.7%     |
| **minsky-reviewer** | **28.7%** | **47.4%** | **35.7%** |
| GitHub Copilot      | 24.7%     | 52.6%     | 33.6%     |
| Qodo                | 25.6%     | 44.5%     | 32.5%     |
| Gemini              | 26.3%     | 33.6%     | 29.5%     |
| Graphite            | 73.3%     | 6.4%      | 11.7%     |

minsky-reviewer sits mid-pack: below CodeRabbit, Propel, and Greptile; above Copilot, Qodo,
Gemini, and well above Graphite (whose near-zero recall reflects a precision-only tuning, not
a comparable review style). This is genuine signal from the identical gold set and pipeline
every other row was scored by — not a number we produced by running any vendor's product
(per the spec's Out-of-scope: vendor scores are read from this published leaderboard only).

## Cost — measured, not estimated, across all three passes

| Pass                                                                | Cost (USD)   |
| ------------------------------------------------------------------- | ------------ |
| Generation (50 reviews, `openai:gpt-5`, production reviewer config) | $8.6432      |
| Extraction + dedup + judge (`openai_gpt-5.2`)                       | $2.1303      |
| **Total**                                                           | **$10.7735** |

Against the spec's ~$17 budget. Both figures are real API usage, not projections: generation
cost comes from `ReviewOutput.usage` on every call (`../results/benchmark_data-generation-meta.json`,
via `token-cost.ts`'s `computeCostUsd` — the same function that prices production
`review_timing` rows); the extraction/dedup/judge figure comes from a scratch usage-logging
hook patched into the installed `openai` client for this run only (never touching the pinned
checkout's own files), priced at gpt-5.2's published rate ($1.75 / $0.175 cached / $14.00 per
MTok — read 2026-08-25 from `developers.openai.com/api/docs/pricing`).

## Limitations

1. **Generic bug-finding only.** These 50 PRs carry no Minsky task spec, so no spec verification
   happens here — `submit_spec_verification` has nothing to check. This benchmark measures only
   the half of the reviewer's job a vendor could in principle replace, not spec-adherence
   checking.

2. **36% of reviews were genuinely truncated by the production round cap, not merely
   budget-consuming.** 46 of 50 reviews hit `MAX_TOOL_ROUNDS = 10`. Of those, only 28 called
   `conclude_review` themselves (`concludedInLoop: true` — a real completion that happened to
   land on the last round). **The other 18/50 (36%) never concluded on their own**
   (`concludedInLoop: false`; the run log shows `forcedConcludeGateBranch:
"emitted_no_conclude"` — the model neither concluded nor took further action in its final
   round, and a post-loop forced pass supplied the conclusion). For those 18 PRs the reported
   findings may be incomplete relative to what the model would have produced with more budget.
   This is production's actual round cap (`services/reviewer/src/providers.ts`'s
   `MAX_TOOL_ROUNDS`), not an artifact of this benchmark, and it is concentrated in the
   larger/more complex repos in the corpus (Keycloak, Grafana, large Cal.com PRs) — see the full
   list of truncated PR URLs in `../results/benchmark_data-generation-meta.json`
   (`concludedInLoop: false` entries).

3. **Judge-model dependence.** This score used `openai_gpt-5.2`. Martian's own leaderboard
   reports separately per judge model precisely because judges disagree; this F1 is not
   comparable to a score computed with a different judge, including production's own
   `claude-sonnet-4-6` review model (a different concern — the judge scores OUR output, it
   does not generate it).

4. **Zero generation failures — not a limitation, recorded for completeness.** All 50 PRs
   generated successfully (0 permanent failures after the retry-and-isolate fix added mid-run;
   see the task spec's Planning Audit for the two mid-run incidents this task hit and resolved:
   an OpenAI credit exhaustion and a single-PR-timeout-kills-batch defect). Comparability rests
   on scoring all 50, and all 50 were scored.

## Reproducing this run

See `../martian-bench/PIN.md` for the pinned SHA, the tarball workaround for `git clone` being
unavailable in `session_exec`, and the exact `step2`/`step2_5`/`step3` commands. Generation:

```bash
bun services/reviewer/eval/martian-bench-generate.ts \
  --golden <pinned-checkout>/offline/golden_comments \
  --concurrency 3 \
  --out services/reviewer/eval/results/benchmark_data.json
```
