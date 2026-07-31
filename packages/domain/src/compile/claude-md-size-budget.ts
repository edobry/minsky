/**
 * Shared default size budget for the `claude.md` compile target (mt#3075).
 *
 * Both compile pipelines have their own `claude-md.ts` target module:
 *   - `packages/domain/src/rules/compile/targets/claude-md.ts` — the legacy,
 *     currently-authoritative pipeline.
 *   - `packages/domain/src/compile/targets/claude-md.ts` — the new pipeline
 *     (mt#2992), dormant until the mt#3058 cutover.
 *
 * Before mt#3075 each target declared its OWN copy of
 * `DEFAULT_CLAUDE_MD_SIZE_BUDGET`. mt#3052/mt#3061 (2026-07-22) raised the
 * legacy pipeline's thresholds 115_000/140_000 -> 135_000/145_000 but only
 * touched the legacy copy — the new pipeline's copy silently drifted back to
 * the old, stricter values. Because the new pipeline is dormant, the drift
 * was invisible until the mt#3058 cutover, at which point every compile
 * would have immediately hard-failed against the reverted 140_000 fail
 * threshold (the corpus already exceeds it). This module is the single
 * shared source both targets import, so a future threshold change can only
 * happen in one place and cannot re-diverge.
 *
 * This file deliberately lives under `packages/domain/src/compile/` (the new
 * pipeline's home) rather than under `packages/domain/src/rules/compile/`
 * (the legacy tree mt#2996 eventually deletes) — see the new pipeline's
 * `claude-md.ts` module doc for why it avoids importing from the
 * soon-to-be-deleted legacy tree. When mt#2996 lands, the legacy target's
 * import of this constant is removed along with the rest of that file; this
 * module and the new pipeline's import survive unchanged.
 *
 * Rationale for the specific numbers (grounded in the 2026-07-15 planning
 * calibration, refined 2026-07-22):
 *   - `failChars` sits with margin under the ~150k harness advisory
 *     truncation-adjacent threshold Claude Code applies for 1M-context
 *     models. Raised 140k -> 145k on 2026-07-22 (mt#3061, operator-decided)
 *     after the corpus reached 141,178 chars and the fail gate began
 *     blocking EVERY rule commit — including size-REDUCING ones (mt#3061
 *     itself is a net -14 change that could not land under the old
 *     threshold). Blocking changes that shrink the corpus is the one outcome
 *     this gate should never produce.
 *   - `warnChars` raised 115k -> 135k on 2026-07-22 (mt#3052, operator-decided
 *     — "option a" of the two dispositions mt#3052's spec sanctioned: "trim
 *     toward 115K, or raise the threshold with a recorded rationale").
 *     mt#3052 applied the rule-admission ladder in reverse to the top-5
 *     always-apply contributors (`decision-defaults.mdc`,
 *     `user-preferences.mdc`, `communication-contract.mdc`,
 *     `hook-files.mdc`, `work-completion.mdc`), moving every incident-shaped
 *     and reference-shaped narrative to `docs/rules-rationale/` and
 *     `docs/architecture/hooks/`, leaving one-line pointers. That trim
 *     brought the corpus from 142,835 to 133,159 chars (-9.7k) — but what
 *     remained after the ladder-reversal in all five rules was overwhelmingly
 *     genuine per-turn directive (probe sequences, trigger-phrase lists,
 *     checklists, hook override/fail-posture facts, the
 *     {Minsky-answer, generic-SE-override} policy-corpus pairs) that fails
 *     the mt#1876 removal test ("would removal cause an agent to skip a
 *     check it runs every turn?") if cut further. The original 115,000
 *     (mt#2802) was aspirational, set before this corpus had actually been
 *     trimmed once; the real floor of always-needed directive discipline,
 *     post-trim, is ~133k. `warnChars` -> 135,000 gives ~1.8k headroom above
 *     that trimmed floor and stops the permanently-firing advisory (a
 *     warning that always fires trains everyone to ignore it — the exact
 *     failure mode mt#3052's own framing named). `failChars` stays 145,000
 *     unchanged (~5k under the ~150,000 harness advisory) — the next change
 *     to hit warn OR fail should still trim first; a leaner corpus remains
 *     available via mt#3068's optional lever (demoting one of the five rules
 *     below `alwaysApply: true` entirely — a scope-of-guidance reduction,
 *     not a compression exercise).
 */
import type { SizeBudget } from "./size-budget";

export const DEFAULT_CLAUDE_MD_SIZE_BUDGET: SizeBudget = {
  warnChars: 135_000,
  failChars: 145_000,
};
