/**
 * Rules Configuration Operations
 *
 * Functions for reading/writing rules selection config (presets/enabled/disabled)
 * and enabling/disabling individual rules.
 */

import fs from "fs/promises";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { log } from "@minsky/shared/logger";
import { RuleService } from "../../rules";
import { resolveActiveRules } from "../rule-selection";
import { RULE_PRESETS } from "../../configuration/schemas/rules";
import { loadRuleCorpus } from "../corpus";
import { ValidationError, getErrorMessage } from "../../errors/index";
import type { RulesSelectionConfig, RulesConfigResult, RulesPresetsResult } from "./types";

// ─── Rules Selection Config ──────────────────────────────────────────────────

/**
 * Read the rules selection config (presets/enabled/disabled) from the project
 * config file (.minsky/config.yaml). Returns defaults if file doesn't exist.
 */
export async function readRulesSelectionConfig(
  workspacePath: string
): Promise<RulesSelectionConfig> {
  const configPath = join(workspacePath, ".minsky", "config.yaml");
  let raw: Record<string, unknown> = {};

  try {
    const content = String(await fs.readFile(configPath, "utf8"));
    raw = parseYaml(content) || {};
  } catch {
    // File doesn't exist or is unreadable — start from empty config
  }

  const rules = (raw?.rules as Record<string, unknown>) || {};
  return {
    presets: Array.isArray(rules.presets) ? (rules.presets as string[]) : [],
    enabled: Array.isArray(rules.enabled) ? (rules.enabled as string[]) : [],
    disabled: Array.isArray(rules.disabled) ? (rules.disabled as string[]) : [],
  };
}

/**
 * Write the rules selection config back to the project config file.
 */
export async function writeRulesSelectionConfig(
  workspacePath: string,
  config: RulesSelectionConfig
): Promise<void> {
  const minskyDir = join(workspacePath, ".minsky");
  const configPath = join(minskyDir, "config.yaml");

  let raw: Record<string, unknown> = {};
  try {
    const content = String(await fs.readFile(configPath, "utf8"));
    raw = parseYaml(content) || {};
  } catch {
    // File doesn't exist — create fresh
  }

  if (!raw.rules) raw.rules = {};
  (raw.rules as Record<string, unknown>).presets = config.presets;
  (raw.rules as Record<string, unknown>).enabled = config.enabled;
  (raw.rules as Record<string, unknown>).disabled = config.disabled;

  // Ensure directory exists
  try {
    await fs.mkdir(minskyDir, { recursive: true });
  } catch {
    // Already exists
  }

  await fs.writeFile(configPath, stringifyYaml(raw, { indent: 2 }), "utf8");
}

// ─── Enable / Disable ────────────────────────────────────────────────────────

/**
 * Every rule id this project could legitimately select: the `.minsky/rules/`
 * sources present on disk, plus the ids `init` can scaffold.
 *
 * The template ids are included deliberately (mt#4866 SC1). A user may reasonably
 * decline a rule `init` is about to write, or one they deleted by hand, and neither
 * appears in `listRules`. Validating against on-disk sources alone would reject
 * those as typos.
 *
 * Read from the shipped CORPUS rather than from the narrower list `init` writes,
 * so a declinable rule that ships but is not scaffolded is still a selectable id.
 *
 * mt#4974 SC6 re-pointed this from `DEFAULT_TEMPLATES` — the retired template
 * registry — to `loadRuleCorpus`. It is the same question asked of a different
 * source of truth: "which ids could this project legitimately name?" The move was
 * forced rather than optional, since deleting the template system removes the
 * only registry this had. Note the set got LARGER and more honest: the templates
 * offered 7 ids, of which 6 were ever written; the corpus offers 17, of which 4
 * are written today and 13 become selectable when Phase 2 (mt#573) lands.
 */
async function knownRuleIds(workspacePath: string): Promise<Set<string>> {
  const ruleService = new RuleService(workspacePath);
  const ids = new Set<string>();

  try {
    for (const rule of await ruleService.listRules({})) ids.add(rule.id);
  } catch (error) {
    // A workspace with no `.minsky/rules/` yet is the fresh-init case, not a
    // failure: the corpus ids below still make validation meaningful. Surfaced
    // rather than swallowed, so a genuinely broken rules directory is visible.
    log.debug("rules selection: could not list on-disk rules while validating an id", {
      workspacePath,
      error: getErrorMessage(error),
    });
  }

  try {
    for (const rule of await loadRuleCorpus()) ids.add(rule.id);
  } catch (error) {
    // Same posture as above, and for the same reason: a missing corpus must not
    // turn a valid `rules disable` into a spurious "unknown rule id". The
    // on-disk ids collected above still make validation meaningful, and
    // `resolveRuleCorpusDir` has already failed loudly by the time we get here.
    log.debug("rules selection: could not load the shipped corpus while validating an id", {
      error: getErrorMessage(error),
    });
  }

  return ids;
}

/**
 * Throw unless `ruleId` names a rule this project could select.
 *
 * MUST run before any config read/write (mt#4866 SC1): the pre-fix behaviour was
 * `rules disable --id no-such-rule` returning success and persisting the unknown
 * id into the committed `.minsky/config.yaml`. Combined with the resolver defect
 * fixed in the same task, that config then resolved to zero rules.
 */
async function assertKnownRuleId(workspacePath: string, ruleId: string): Promise<void> {
  const known = await knownRuleIds(workspacePath);
  if (known.has(ruleId)) return;

  const suggestions = [...known].sort().slice(0, 8);
  throw new ValidationError(
    `Unknown rule id "${ruleId}" — it is neither a rule in .minsky/rules nor a rule ` +
      `minsky init can scaffold, so nothing would be selected. The project config was ` +
      `not written.\n\nKnown ids include: ${suggestions.join(", ")}${
        known.size > suggestions.length ? `, … (${known.size} total)` : ""
      }\n\nRun \`minsky rules list\` for the full set.`
  );
}

/**
 * Enable a rule by adding it to the enabled list and removing from disabled.
 */
export async function enableRule(
  workspacePath: string,
  ruleId: string
): Promise<{ enabled: string[]; disabled: string[] }> {
  await assertKnownRuleId(workspacePath, ruleId);

  const config = await readRulesSelectionConfig(workspacePath);

  if (!config.enabled.includes(ruleId)) {
    config.enabled.push(ruleId);
  }
  // Remove from disabled if present
  config.disabled = config.disabled.filter((id) => id !== ruleId);

  await writeRulesSelectionConfig(workspacePath, config);
  return { enabled: config.enabled, disabled: config.disabled };
}

/**
 * Disable a rule by adding it to the disabled list and removing from enabled.
 */
export async function disableRule(
  workspacePath: string,
  ruleId: string
): Promise<{ enabled: string[]; disabled: string[] }> {
  await assertKnownRuleId(workspacePath, ruleId);

  const config = await readRulesSelectionConfig(workspacePath);

  if (!config.disabled.includes(ruleId)) {
    config.disabled.push(ruleId);
  }
  // Remove from enabled if present
  config.enabled = config.enabled.filter((id) => id !== ruleId);

  await writeRulesSelectionConfig(workspacePath, config);
  return { enabled: config.enabled, disabled: config.disabled };
}

// ─── Config / Presets ────────────────────────────────────────────────────────

/**
 * Get the current rules configuration state including active rule count.
 */
export async function getRulesConfig(workspacePath: string): Promise<RulesConfigResult> {
  const config = await readRulesSelectionConfig(workspacePath);

  const ruleService = new RuleService(workspacePath);
  const allRules = await ruleService.listRules({});
  const allRuleIds = allRules.map((r) => r.id);
  const activeIds = resolveActiveRules(allRuleIds, config);

  return {
    success: true,
    presets: config.presets,
    enabled: config.enabled,
    disabled: config.disabled,
    activeRuleCount: activeIds.size,
    totalRuleCount: allRuleIds.length,
  };
}

/**
 * List available rule presets with their rule counts.
 */
export function getRulesPresets(): RulesPresetsResult {
  const presets = Object.entries(RULE_PRESETS).map(([name, ruleIds]) => ({
    name,
    ruleCount: ruleIds.length,
    rules: ruleIds,
  }));
  return { success: true, presets };
}
