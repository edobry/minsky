# Martian Code Review Bench — vendor pin

mt#4577 scores `minsky-reviewer` on Martian's offline Code Review Bench gold set. Per that spec's
"Vendoring (SC1)" section, this task **pins** the benchmark rather than vendoring its Python source
into this TypeScript monorepo — the pipeline is `uv`-managed and belongs in its own checkout.

## Pinned commit

```
repo:   https://github.com/withmartian/code-review-benchmark
sha:    2b092b670f7d6cae6d429babaaee18948b4bdacb
branch: main
read:   2026-08-25
```

Reproduce a run from this pin:

```bash
git clone https://github.com/withmartian/code-review-benchmark.git /tmp/martian-bench
cd /tmp/martian-bench
git checkout 2b092b670f7d6cae6d429babaaee18948b4bdacb
cd offline && uv sync
```

## What we use from the pinned checkout, and what we don't

The benchmark's own `offline/README.md` documents a 6-step pipeline (fork → download → extract →
dedup → judge → dashboard). This task's generation half (`martian-bench-generate.ts`, this
directory's sibling script) **replaces steps 0 and 1** (`step0_fork_prs.py`, `step1_download_prs.py`)
rather than running them:

- Step 0 forks each benchmark PR into a new GitHub org so the tool under evaluation can review it
  live via GitHub. Step 1 then scrapes the tool's bot-authored comments back off that fork via
  `gh api`. Both exist to solve "how do we get a tool's review onto a page we can scrape" for a
  tool that only reviews PRs it's installed on. `minsky-reviewer`'s review-generation path
  (`callReviewer()` in `services/reviewer/src/providers.ts`) has no such constraint — it can be
  invoked directly against any PR's diff, given a GitHub token to read it.
- `martian-bench-generate.ts` fetches each of the 50 original PRs' diff/title/body directly
  (read-only, no fork, no new GitHub App installation), runs them through
  `minsky-reviewer`'s real prompt/model path, and writes `results/benchmark_data.json` in the
  exact schema `step1_download_prs.py` would have produced (documented in `offline/README.md` →
  "Data format").
- From there, **steps 2 through 4 run completely unmodified** against the pinned checkout:

  ```bash
  cd /tmp/martian-bench/offline
  uv run python -m code_review_benchmark.step2_extract_comments --tool minsky
  uv run python -m code_review_benchmark.step2_5_dedup_candidates --tool minsky
  uv run python -m code_review_benchmark.step3_judge_comments --tool minsky \
    --dedup-groups results/$MARTIAN_MODEL/dedup_groups.json
  ```

  Those three steps are what determines comparability (candidate extraction, dedup, the LLM judge,
  and the precision/recall/F1 math) — every other tool on the published leaderboard was scored by
  this same code, unmodified.

## Judge model / credentials

`step3_judge_comments.py`'s `LLMJudge` is a bare `AsyncOpenAI(api_key=MARTIAN_API_KEY,
base_url=MARTIAN_BASE_URL)` (see the file at the pinned SHA). No Martian API account is required:
point `MARTIAN_BASE_URL` at an OpenAI-compatible endpoint we already hold credentials for and set
`MARTIAN_MODEL` to one of the three judge models the published leaderboard reports against:

- `anthropic_claude-opus-4-5-20251101`
- `anthropic_claude-sonnet-4-5-20250929`
- `openai_gpt-5.2`

Full investigation trail, the SC3 split-hypothesis resolution, and the remaining implementation
steps live in the mt#4577 task spec's "Planning Audit" section.
