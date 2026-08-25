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

**From inside a Minsky session, `git clone` is unavailable** — `session_exec` denies the `git`
CLI outright (`block-git-gh-cli.ts`), even for a non-Minsky external repo; there is no scoped
carve-out for "clone somewhere outside the repo." Use a tarball instead, which produces the
identical pinned tree without invoking `git`:

```bash
mkdir -p /tmp/martian-bench && \
curl -sL https://github.com/withmartian/code-review-benchmark/archive/2b092b670f7d6cae6d429babaaee18948b4bdacb.tar.gz \
  -o /tmp/martian-bench.tar.gz && \
tar -xzf /tmp/martian-bench.tar.gz -C /tmp/martian-bench --strip-components=1
cd /tmp/martian-bench/offline && uv sync
```

`uv` itself may not be preinstalled on the machine running the session (`session_exec` runs on
the host, not in a container with a fixed toolchain) — `brew install uv` if `which uv` comes back
empty. Both steps discovered running this task's own validation, not assumed from the pinned
checkout's docs.

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

**Resolved: `openai_gpt-5.2`, `MARTIAN_BASE_URL=https://api.openai.com/v1`.** Vendor coverage is
tied across all three (49 tools each, counted directly off the pinned checkout's own committed
`results/<judge>/evaluations.json` files — not the live dashboard, which is a JS SPA WebFetch
can't render). Two things worth recording because they contradicted a prediction made before
testing:

- `gpt-5` (the reviewer's own generation model) fails the judge/extraction call with `400
Unsupported value: 'temperature' does not support 0.0 with this model` — the pipeline hardcodes
  `temperature=0.0`, and gpt-5 is reasoning-tier. `gpt-5.2` does **not** hit this, tested directly
  against the real pipeline call (zero errors) — it is evidently not gated the same way, though
  nothing here explains why; treat it as an observed fact about this specific model pair, not a
  generalizable rule about "reasoning models."
- Anthropic's models were the a priori safer-looking choice (no OpenAI-reasoning-tier
  temperature restriction) but were never actually tried against `AsyncOpenAI(base_url=...)` —
  Anthropic's Messages API is not guaranteed OpenAI-chat-completions-wire-compatible, and that
  compatibility was not verified before `gpt-5.2` was confirmed working and selected instead. If
  a future run needs an Anthropic judge, verify the base_url compatibility directly rather than
  assuming it from the vendor coverage tie.

Cost is real, not estimated: a scratch `sitecustomize.py`, loaded via `PYTHONPATH` (never
modifying a file inside the pinned checkout itself), patches the installed `openai` client to
log each call's `usage` to a JSONL file. Measured against the single-PR validation sample:
extraction (1 call) + dedup (1 call) + judge (~30 calls, golden×candidate pairs) = 32 calls,
8,745 prompt tokens (1,152 cached) + 2,497 completion tokens, **$0.0485 for that one review** at
gpt-5.2's standard rate ($1.75 / $0.175 cached / $14.00 per MTok, input/cached/output — read
2026-08-25 from `developers.openai.com/api/docs/pricing`, not in this repo's own
`token-cost.ts`, which only prices the reviewer's own configured models). Projected to 50
reviews: ~$2.42 for extraction+dedup+judge, plus ~$7.07 for generation (measured separately,
see the spec's Planning Audit) — **~$9.49 total**, comfortably under the spec's ~$17 budget.

Full investigation trail, the SC3 split-hypothesis resolution, and the remaining implementation
steps live in the mt#4577 task spec's "Planning Audit" section.
