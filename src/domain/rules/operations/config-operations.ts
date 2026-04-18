/**
 * Rules Configuration Operations
 *
 * Functions for reading/writing rules selection config (presets/enabled/disabled)
 * and enabling/disabling individual rules.
 */

import fs from "fs/promises";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { RuleService } from "../../rules";
import { resolveActiveRules } from "../rule-selection";
import { RULE_PRESETS } from "../../configuration/schemas/rules";
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
 * Enable a rule by adding it to the enabled list and removing from disabled.
 */
export async function enableRule(
  workspacePath: string,
  ruleId: string
): Promise<{ enabled: string[]; disabled: string[] }> {
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
