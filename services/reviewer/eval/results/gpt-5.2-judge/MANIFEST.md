# gpt-5.2-judge/ — provenance and file guide

These three files are copied **verbatim, unmodified** from the pinned Martian Code Review Bench
checkout's own working directory after running its pipeline against our generated reviews — they
are not something this repo's code produced or reformatted. Editing them to add fields here would
contradict the mt#4577 spec's SC3 requirement that scoring uses Martian's own pipeline, not a
reimplementation; this manifest carries the provenance instead, alongside the data rather than
inside it.

| Field                   | Value                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Pinned benchmark commit | `2b092b670f7d6cae6d429babaaee18948b4bdacb` — see `../martian-bench/PIN.md`                                |
| Judge model             | `openai_gpt-5.2`                                                                                          |
| Pipeline steps run      | `step2_extract_comments.py` -> `step2_5_dedup_candidates.py` -> `step3_judge_comments.py`, all unmodified |
| Input                   | `../benchmark_data.json` (this run's 50 generated reviews)                                                |
| Run date                | 2026-08-25                                                                                                |

## File guide

| File                | Size | Lines | Produced by                   | Contents                                                                                                                                                                    |
| ------------------- | ---- | ----- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidates.json`   | 96K  | 2068  | `step2_extract_comments.py`   | Extracted candidate comments per PR, before dedup                                                                                                                           |
| `dedup_groups.json` | 8.0K | 152   | `step2_5_dedup_candidates.py` | Grouping of near-duplicate candidates                                                                                                                                       |
| `evaluations.json`  | 180K | 2858  | `step3_judge_comments.py`     | Per-PR judge verdicts: matched/unmatched candidates against golden comments, true/false positive/negative breakdown — the source of `REPORT.md`'s precision/recall/F1 table |

`evaluations.json` is the largest file and the one most likely to need windowing if read
programmatically — it is keyed by PR URL, so `jq '.["<pr-url>"]'` or a streaming JSON parser over
one key at a time avoids loading the full 180K in one pass. `REPORT.md`'s score table is the
already-aggregated summary; read these raw files only when a per-PR breakdown is needed.
