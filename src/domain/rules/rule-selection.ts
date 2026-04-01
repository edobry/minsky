/**
 * Rule Selection
 *
 * Resolves which rules are active based on config (presets + enabled + disabled).
 */

import { RULE_PRESETS } from "../configuration/schemas/rules";

/**
 * Resolves which rules are active based on config (presets + enabled + disabled).
 * Returns a Set of rule IDs that should be included in compilation.
 * If no presets/enabled/disabled are configured, ALL rules are active (backward compat).
 */
export function resolveActiveRules(
  allRuleIds: string[],
  config: { presets: string[]; enabled: string[]; disabled: string[] }
): Set<string> {
  // If nothing configured, all rules are active
  if (config.presets.length === 0 && config.enabled.length === 0 && config.disabled.length === 0) {
    return new Set(allRuleIds);
  }

  // Start with preset rules
  const active = new Set<string>();
  for (const presetName of config.presets) {
    const presetRules = RULE_PRESETS[presetName];
    if (presetRules) {
      for (const id of presetRules) active.add(id);
    }
  }

  // Add individually enabled rules
  for (const id of config.enabled) active.add(id);

  // Remove disabled rules
  for (const id of config.disabled) active.delete(id);

  return active;
}
