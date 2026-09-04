/**
 * Rule Selection
 *
 * Resolves which rules are active based on config (presets + enabled + disabled).
 */

import { RULE_PRESETS } from "../configuration/schemas/rules";

/**
 * Resolves which rules are active based on config (presets + enabled + disabled).
 * Returns a Set of rule IDs that should be included in compilation.
 *
 * **Semantics (mt#4866 SC6).** The active set STARTS FROM the full corpus;
 * `presets` and `enabled` ADD to it, and `disabled` SUBTRACTS. A config with only
 * `disabled` set therefore never empties the corpus.
 *
 * This replaces an allow-list resolver that started from the EMPTY set the moment
 * ANY of the three fields was non-empty. Because `disableRule` writes
 * `disabled: [id]` with the other two empty, the first `rules disable` a user ran
 * on a fresh project resolved to ZERO rules — measured live 2026-09-04, and
 * invisible until now only because nothing consumes this resolver yet. RFC Phase 2
 * (mt#573) wires it, so it had to be correct first.
 *
 * **Phase-0 scope substitution, recorded.** The governing RFC ("The rules Minsky
 * ships", Accepted 2026-09-04) says the active set "starts from **the tier defaults
 * at the project's rung**". Tier defaults and adoption rungs do not exist yet —
 * they are Phase 1a's first deliverable (frontmatter passthrough for plane, tier
 * and minimum rung). While every rule is un-tiered, "tier defaults at the rung"
 * degenerates to "the whole corpus", which is what this function uses.
 *
 * **mt#573 must re-derive the base set from tier defaults** rather than inheriting
 * `allRuleIds` as though the RFC had said so. Until then `presets` / `enabled` are
 * necessarily inert — everything they could add is already in the base set — and
 * that is a consequence of the substitution, not an independent design choice.
 *
 * The corpus intersection below is NOT inert, though, and is why it is written as
 * real code rather than skipped: `RULE_PRESETS` currently names 13 ids that exist
 * only in Minsky's own repository plus 3 that exist nowhere, so a preset can name
 * a rule this project does not have. Intersecting keeps such an id from counting
 * toward `activeRuleCount` and from reaching a compile target.
 */
export function resolveActiveRules(
  allRuleIds: string[],
  config: { presets: string[]; enabled: string[]; disabled: string[] }
): Set<string> {
  const corpus = new Set(allRuleIds);

  // Phase-0 base set: the whole corpus. See the docblock — this is the degenerate
  // case of the RFC's "tier defaults at the project's rung", not a separate rule.
  const active = new Set(corpus);

  // Presets add. Intersected with the corpus so a preset naming a rule this
  // project does not have cannot inflate the active set.
  for (const presetName of config.presets) {
    const presetRules = RULE_PRESETS[presetName];
    if (presetRules) {
      for (const id of presetRules) {
        if (corpus.has(id)) active.add(id);
      }
    }
  }

  // Individually enabled rules add, under the same intersection.
  for (const id of config.enabled) {
    if (corpus.has(id)) active.add(id);
  }

  // Disabled subtracts, and wins over both of the above.
  for (const id of config.disabled) active.delete(id);

  return active;
}
