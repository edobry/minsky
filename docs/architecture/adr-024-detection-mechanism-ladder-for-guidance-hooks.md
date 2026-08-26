# ADR-024: Detection-mechanism ladder for the guidance-hook family

## Status

**Accepted** (2026-06-25)

Derived from the RFC _Detection-mechanism strategy for the guidance-hook family_ (Notion
`383937f0-3cb4-819d-8024-cf7aa778773f`, Accepted 2026-06-25; task mt#2263; memory anchor
`d9c10ef1`). Records the **direction** (a ladder), not a single fixed mechanism. Corrects the
prior "hooks can't detect semantic coherence" framing in
`docs/architecture/agent-guidance-mechanisms.md` (fixed in the same change).

**Amended 2026-08-03 (mt#3652): Rung 3 reached for the retrospective-trigger family; mechanism
decided.** Both halves of the sign-off (a)/(c) gate were satisfied: the measured insufficiency
of Rungs 1-2 (mt#3408's Rung-2 precision: 3/3 hand-classified false positives against sign-off
(b)'s 0-known-FP bar, forcing permanent log-only; plus three live Rung-1 recall misses on
record — mt#3341 and the two 2026-08-03 mt#3639 misses), and the principal decision the ADR
reserves (mt#3521 `## Principal disposition`, 2026-08-03: option (b), "go up the rungs").
The offline pilot (`scripts/pilot-rung3-confirm.ts`, 13 labeled turns) decided the mechanism:
**generative Haiku confirm** — 6/6 positives fired (pipeline = Rung 1 ∪ confirmed), 0/7 false
positives including all three of mt#3408's FP sentences verbatim; the **discriminative** arm is
not trainable at the current corpus size (13 labeled turns against this ADR's own ~50-200
fine-tune floor) and is revisited only if the labeled corpus — now growing via the evaluation
stream below — reaches the floor AND the generative arm's measured precision degrades. The
confirm stage runs ONLY on Rung-2 nominations (per §Rung 3's design), ships enforcing (a
confirmed nomination injects; kill switch `MINSKY_DISABLE_RUNG3_CONFIRM`), and preserves both
cross-cutting invariants: fail-to-Rung-1 on every failure path, and the coverage-receipt gate.
Raw Rung-2 enforcement (`MINSKY_RUNG2_NOMINATION_ENFORCE`) is untouched and stays off. This
amendment also adds the family's **evaluation stream**
(`.minsky/retrospective-trigger-evaluations.jsonl`, every evaluated turn recorded, fired or
not) — the measurement substrate a fire-only calibration log cannot provide, and the input that
keeps both the FP rate and the false-negative rate observable post-ship.

**Amended 2026-08-26 (mt#4595): where this ladder STOPS — the command-string guard family is
outside it, not terminal within it.** `## Context` below scopes this family to `UserPromptSubmit`
guidance hooks matching behavioral trigger phrases in the agent's own **prose**. A guard that
decides from a **closed vocabulary** — a parsed shell command, a filesystem path, an enum value, a
config key — has no paraphrase axis, so Rung 2's gate ("only if paraphrase misses recur") cannot be
met, and Rung 3 nominates only on Rung 2. Neither rung applies: **this ADR does not govern such a
guard.** Rung 1 is where it sits because the ladder's question does not arise for it — not because
a climb gate went unmet. **The general test, so a fourth case needs no fresh investigation:** the
matched surface is a closed vocabulary → **out of family**; the matched surface is prose → **in
family**, climb-eligible on evidence.

Named instances, all `PreToolUse` guards registered on the `Bash|mcp__minsky__session_exec`
matcher: **`cli-mcp-substitution`** (mt#4144), **`truncated-outcome-read`** (mt#4096),
**`nonexistent-search-path`** (mt#4215), together with their siblings enumerated in
`.minsky/hooks/registry-command-string-guards.ts` §"The family boundary" — **the canonical
statement of this boundary, which this amendment points at rather than copies.** Postures for
those guards are decided per guard on the ordinary evidence, not by climbing this ladder.

**Recorded here because it was recorded everywhere except here.** Two planning passes reached for
the ladder from the ADR side and mis-placed a guard on it: mt#4096 concluded Rung 1's
markdown-elision prescription answered a shell heredoc (it does not — a heredoc is not markdown),
and mt#4144 recorded its guard as "extends ADR-024 at Rung 1," which, in its own words, "overstates
the ADR's reach." Both were caught only at implementation, after the planning audit had passed.
The reasoning existed in each guard's source the whole time; this ADR carried the ladder and no
statement of its own edge, so nothing on **this** side said stop.

**The cheapest architecture and the compliant one coincide here — and the reason is scope, not
budget.** These are the family's highest-volume guards, so not climbing them removes the bulk of
what a climb-everything design would cost. **mt#4565 measured that cost and is where to read it**;
no figure is repeated here, so there is one copy to keep true. The saving is a consequence, not the
justification: a larger budget would not make a paraphrase axis exist. Do not re-read this
exclusion later as a cost concession that more money reverses.

**Same test, sibling subject.** ADR-042 §"The discriminator, and why it is not a preference"
applies it to the gate-battery checkers — _"A checker that reads an ARTIFACT … or joins against
TOOL CALLS … has no paraphrase axis and is outside that family."_ One test, two subjects.

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
- **ADR-031** — the event-axis sibling of this ADR (task mt#3292): WHICH lifecycle event the same
  family scans on, and what it reads there. This ADR decides the _mechanism_ (how a detector
  matches) and deliberately leaves the _event_ open; ADR-031 closes it. The two are orthogonal and
  compose: any rung of this ladder runs against whatever window ADR-031 resolves.
- Phase tasks: **mt#2554** (Phase 1 — Rung-1 prefilter), **mt#2557** (Phase 0 — this ADR + doc-fix).
- `docs/architecture/agent-guidance-mechanisms.md` — corrected in this change (the "strength
  ordering" + hook framework this ADR refines).
- **ADR-034** — symbol identification in `code-mechanism-assertion`. A scope boundary of THIS
  ADR, recorded there rather than here: the rungs below are about matching trigger PHRASES, so
  they do not reach the separate question of whether a token names a code symbol at all. That
  axis went five rounds of shape exclusions without a rung to belong to; ADR-034 names it and
  decides it (shape-based, allowlist rejected on measurement) — with three explicit conditions
  that reopen the question, so the rejection is bounded rather than permanent.
- **`.minsky/hooks/registry-command-string-guards.ts`** §"The family boundary" — the canonical
  statement of the scope boundary recorded in the 2026-08-26 amendment above, and the enumeration
  of the guards it covers. Unlike ADR-034 (a boundary recorded in a sibling ADR), this one lives in
  the registry the guards are declared in, so it stays adjacent to what it describes. Read it
  before deciding any command-string guard's posture; the amendment points here rather than
  copying it, so there is one copy to keep true.
- **ADR-042** — `docs/architecture/adr-042-gate-battery-enforcement-shape.md` §"The discriminator,
  and why it is not a preference" applies this ADR's paraphrase-axis test to the `/plan-task` gate
  battery's checkers. Same test, different subject; it cites this ADR's `## Context` for the scope
  sentence the amendment above makes explicit.
- Reuse: `.claude/hooks/block-out-of-band-merge.ts` (`elideMarkdownNonProse` — the Rung-1
  elision pattern); shared detector framework `packages/domain/src/detectors/` (mt#1035,
  mt#1543; part of the attention-allocation subsystem).
- Shipped semantic-detection counter-examples: `.claude/hooks/memory-search.ts` (embedding),
  `.claude/hooks/post-merge-unasked-direction-scan.ts` (Haiku classification via
  `UnaskedDirectionAnalyzer`).
- Prerequisite: **mt#2255** (shared turn-extraction helper — restored hook coverage).
- Field references in the RFC: _Constitutional Classifiers++_ (cascade guardrails); vLLM Semantic
  Router ("rules first, then semantic/LLM"; latency tiers); discriminative-vs-generative for
  binary span tasks.
