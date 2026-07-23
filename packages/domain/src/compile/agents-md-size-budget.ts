/**
 * Shared default size budget for the `agents.md` compile target (mt#3076).
 *
 * Both compile pipelines have their own `agents-md.ts` target module:
 *   - `packages/domain/src/rules/compile/targets/agents-md.ts` — the legacy,
 *     currently-authoritative pipeline.
 *   - `packages/domain/src/compile/targets/agents-md.ts` — the new pipeline
 *     (mt#2992), dormant until the mt#3058 cutover.
 *
 * Before mt#3076 each target declared its OWN copy of
 * `DEFAULT_AGENTS_MD_SIZE_BUDGET` (both hardcoded to the mt#2802 originals,
 * 160_000/200_000) — the exact drift shape mt#3075 fixed for
 * `DEFAULT_CLAUDE_MD_SIZE_BUDGET` (see `claude-md-size-budget.ts`), just not
 * yet applied to this sibling target. This module is the single shared
 * source both targets import, so a future threshold change can only happen
 * in one place and cannot re-diverge.
 *
 * ## Why these numbers changed (mt#3076, 2026-07-23)
 *
 * The 2026-07-22 context-injection audit (memory `5d27f51c` / mem#682) flagged
 * AGENTS.md as over its old 160k warn budget on the then-current tree and
 * asked a prior question first: does anything in THIS environment actually
 * consume AGENTS.md? Investigation (recorded in the mt#3076 spec) found NO
 * evidence of a real consumer — this repo's agents work through Claude Code
 * (reads `CLAUDE.md`) and Cursor (reads `.cursor/rules/`); no CI workflow, no
 * bot, no service, and no Minsky runtime code path reads AGENTS.md as agent
 * instructions (the only in-repo reads are the compile pipeline's own
 * round-trip test fixtures and the pre-commit staleness check, both of which
 * read back what Minsky itself just wrote — not external consumption).
 * AGENTS.md is generated purely because `agents.md` is a documented
 * cross-tool convention Minsky supports defensively, not because a consumer
 * is confirmed here.
 *
 * That makes the WARN's original rationale — tracking AGENTS.md against a
 * context-truncation-adjacent ceiling the way `DEFAULT_CLAUDE_MD_SIZE_BUDGET`
 * tracks Claude Code's actual ~150k advisory threshold — moot: there is no
 * known consumer whose context window this budget protects. AGENTS.md's
 * content also isn't independent of CLAUDE.md's — it's CLAUDE.md's
 * always-apply corpus PLUS a small curated-section overhead
 * (`DEFAULT_AGENTS_MD_SECTIONS`), so every CLAUDE.md corpus trim (mt#3052,
 * mt#3061, mt#3083) or regrowth moves AGENTS.md in lockstep without anyone
 * touching this file. Keeping a tight, independently-tracked budget on an
 * unconsumed derivative file just means CLAUDE.md corpus work periodically
 * re-trips an AGENTS.md WARN nobody benefits from fixing — the "perpetual
 * WARN" this task exists to end (a warning that fires without payoff trains
 * everyone to ignore it, the same failure mode mt#3052 named for CLAUDE.md).
 *
 * Disposition: **deprioritize, not remove.** AGENTS.md stays in routine
 * compile (dropping the target entirely was the larger, riskier option this
 * task's spec offered and wasn't warranted — the convention may still get a
 * real consumer later). The budget is raised well past any size the
 * corpus is realistically expected to reach, so it stops firing as a false
 * signal while still catching genuinely pathological runaway growth. If a
 * real consumer is confirmed in the future, re-tighten this budget to track
 * `DEFAULT_CLAUDE_MD_SIZE_BUDGET` the way it originally did.
 */
import type { SizeBudget } from "./size-budget";

export const DEFAULT_AGENTS_MD_SIZE_BUDGET: SizeBudget = {
  warnChars: 300_000,
  failChars: 400_000,
};
