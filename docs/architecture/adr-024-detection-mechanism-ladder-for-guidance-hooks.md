# ADR-024: Detection-mechanism ladder for the guidance-hook family

## Status

**Accepted** (2026-06-25)

Derived from the RFC _Detection-mechanism strategy for the guidance-hook family_ (Notion
`383937f0-3cb4-819d-8024-cf7aa778773f`, Accepted 2026-06-25; task mt#2263; memory anchor
`d9c10ef1`). Records the **direction** (a ladder), not a single fixed mechanism. Corrects the
prior "hooks can't detect semantic coherence" framing in
`docs/architecture/agent-guidance-mechanisms.md` (fixed in the same change).

## Context

Minsky runs several `UserPromptSubmit` **guidance hooks** — `retrospective-trigger-scanner`,
`substrate-bypass-detector`, `pre-narration-detector`, and more in flight — that detect
behavioral trigger phrases in the agent's own output. They all match by **hardcoded literal
regex**, and all share a two-axis failure mode:

- **Recall** — literal lists miss paraphrase. "I owe you a correction" never matched
  `retrospective-trigger-scanner`'s `/I owe you an? apolog/` pattern. Each miss has historically
  been answered by adding another regex family (R1 → R5) — an arms race.
- **Precision** — they over-fire on quotes/discussion of the trigger phrases themselves, which
  is exactly the content the detectors' own subject matter (failure language) generates. The
  phrase "I should have caught" fired as a **false positive at least three times** (2026-06-03,
  2026-06-15, 2026-06-25) where the agent was _quoting/discussing_ it, not admitting a failure.

The family was also **diverging**: one in-flight task proposed adding _more_ regex while another
independently proposed embedding matching. And a repository doc
(`agent-guidance-mechanisms.md:53`) asserted _"Hooks can't detect semantic coherence (that
requires understanding, not pattern matching)"_ — **factually contradicted by shipped code**:
`memory-search.ts` does an embedding round-trip on every turn, and
`post-merge-unasked-direction-scan.ts` sends the transcript to a Haiku-class model. That doc line
is the discoverability root cause of the regex-by-reflex pattern.

An expert-review pass on the original draft (which proposed "semantic/LLM detection as the
default") inverted the position: a deterministic quotation/markdown-elision fix — a pattern
already shipped in `block-out-of-band-merge.ts` — may fix the known false positives at ~zero
cost, making an LLM hybrid disproportionate to the evidence (2 FPs + 1 miss).

## Decision

Fix the family on a **cheapest-sufficient-first, evidence-gated ladder**, built on the shared
`packages/domain/src/detectors/` framework so all guidance hooks consume one mechanism instead of
divergent regex copies:

- **Rung 1 — quotation/citation-aware deterministic prefilter (the default stopping point).**
  Before matching, elide (a) markdown code spans / fenced blocks / blockquote lines — reusing
  `block-out-of-band-merge.ts`'s `elideMarkdownNonProse` same-length-whitespace pass — and
  (b) prose-quoted spans and explicit discussion-framing. Match on the residual. ~Zero added
  cost; directly targets the precision axis. (Prose-quotation detection is the load-bearing,
  harder part; its sufficiency is an empirical gate, not an assumption.)
- **Rung 2 — embedding recall-widening (only if paraphrase misses recur).** Embedding-similarity
  nomination against a small curated exemplar set per family (the `memory-search.ts` cost
  profile), gated on a measured recall-miss rate.
- **Rung 3 — learned confirm (only on measured insufficiency of Rungs 1-2).** A confirm stage on
  nominated candidates only. The mechanism — a fine-tuned **discriminative** classifier
  (BERT-class; near-zero runtime cost; needs ~50-200 labeled examples) vs a **generative** Haiku
  confirm — is decided by an **offline pilot** before committing, not by reuse convenience.

**Cross-cutting invariants:**

- **Fail to Rung-1, never silent-skip.** If a learned stage's provider is unavailable/errors,
  the hook degrades to the deterministic Rung-1 result and _still injects_ (lower precision, no
  missed trigger) + logs a `degraded` marker. Provider-down is where the reminder is _more_
  valuable; silent skip is unacceptable for a discipline mechanism.
- **Coverage-receipt done-gate.** A detector hook is not "done" until its calibration log shows a
  real fire: each entry carries `source: "live" | "synthetic"` + timestamp; the gate passes only
  with ≥1 `source:"live"` true-positive within a 7-day window of ship; zero live fires in 7 days
  retroactively fails the gate and is surfaced for review.

**Principal sign-off (2026-06-25):**

- (a) The ladder **stops at Rung 1 by default**; Rungs 2-3 are strictly evidence-gated.
- (b) **Sufficiency bar: 0 known-FP AND ≤5% new false-negative**, measured on the existing
  `.minsky/*-calibration.jsonl` logs. A phase rolls back to regex-only if FN exceeds the bar.
- (c) The Rung-3 mechanism choice (discriminative vs generative) + its labeling investment are
  **deferred** until Rungs 1-2 are measured.
- (d) The divergent in-flight detector tasks are **reconciled** under the shared mechanism:
  mt#2446 (method-redirect regex) → Rung-1 input; mt#2366 (causal-premise semantic) → Rung-2
  embedding path; mt#2303 / mt#2459 / mt#2428 → Phase-2/3 consumers — they coordinate with the
  phases, not proceed independently.

## Consequences

**Positive.** Ends the regex arms race; gives the family one shared, discoverable mechanism;
corrects the misdirecting doc; the cheapest rung (deterministic prefilter) plausibly fixes the
known false positives at ~zero cost.

**Negative / risks.** Prose-quotation detection (Rung 1's load-bearing part) is harder than
markdown elision and its sufficiency is an empirical claim, gated by measurement against the
calibration corpus. Calibration/drift moves from "enumerate every phrasing" to "tune elision +
exemplars + threshold" — reduced, not eliminated (the `calibration-review` skill is the venue).
Rung-3 cost is real and recurring if ever reached — a principal decision, gated behind measured
insufficiency. Cross-harness portability is out of scope (these are Claude Code hooks).

**Implementation phasing.** Phase 0 = this ADR + the `agent-guidance-mechanisms.md` correction
(mt#2557). Phase 1 = the Rung-1 prefilter + `retrospective-trigger-scanner` migration + the
coverage-receipt gate, behind the measured gate (mt#2554). Phases 2-3 (other-hook propagation;
embedding; learned confirm) are gated by measured evidence, not dates.

## References

- RFC: _Detection-mechanism strategy for the guidance-hook family_ — Notion
  `383937f0-3cb4-819d-8024-cf7aa778773f`; task **mt#2263**; memory `d9c10ef1`.
- Phase tasks: **mt#2554** (Phase 1 — Rung-1 prefilter), **mt#2557** (Phase 0 — this ADR + doc-fix).
- `docs/architecture/agent-guidance-mechanisms.md` — corrected in this change (the "strength
  ordering" + hook framework this ADR refines).
- Reuse: `.claude/hooks/block-out-of-band-merge.ts` (`elideMarkdownNonProse` — the Rung-1
  elision pattern); shared detector framework `packages/domain/src/detectors/` (ADR-008, mt#1035,
  mt#1543).
- Shipped semantic-detection counter-examples: `.claude/hooks/memory-search.ts` (embedding),
  `.claude/hooks/post-merge-unasked-direction-scan.ts` (Haiku classification via
  `UnaskedDirectionAnalyzer`).
- Prerequisite: **mt#2255** (shared turn-extraction helper — restored hook coverage).
- Field references in the RFC: _Constitutional Classifiers++_ (cascade guardrails); vLLM Semantic
  Router ("rules first, then semantic/LLM"; latency tiers); discriminative-vs-generative for
  binary span tasks.
