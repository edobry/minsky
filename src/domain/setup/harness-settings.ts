/**
 * Harness agent performance settings.
 *
 * Detects installed agent harnesses and applies recommended performance settings
 * to their configuration files. Currently supports Claude Code (~/.claude/settings.json).
 *
 * This module is pure domain logic — no CLI imports, no interactive prompts.
 * The interactive layer lives in the command adapter.
 */

import * as path from "path";
import { homedir } from "os";
import { existsSync as fsExistsSync } from "fs";
import type { FsLike } from "../interfaces/fs-like";
import { createRealFs } from "../interfaces/real-fs";
import { deepMergeConfigs } from "../configuration/deep-merge";

/**
 * Recommended performance settings for Claude Code.
 * Keys not listed here are left untouched in the user's settings.json.
 */
export const CLAUDE_CODE_RECOMMENDED_SETTINGS: Record<string, unknown> = {
  model: "sonnet",
  advisorModel: "opus",
  env: {
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "60",
  },
};

export interface HarnessSettingsChange {
  key: string;
  from: unknown;
  to: unknown;
}

export type HarnessSettingsStatus = "applied" | "already-configured" | "not-detected";

export interface HarnessSettingsResult {
  harness: string;
  status: HarnessSettingsStatus;
  changes: HarnessSettingsChange[];
  settingsPath: string;
}

export interface ApplyHarnessSettingsOptions {
  /** Override home directory for config lookup. Defaults to os.homedir(). Useful for testing. */
  homeDir?: string;
  /** If true, compute changes but do not write. */
  dryRun?: boolean;
  /** Override sync existence check. Defaults to fs.existsSync. Useful for testing. */
  checkExists?: (p: string) => boolean;
}

/**
 * Detect whether Claude Code is installed by probing the filesystem.
 * Claude Code stores its settings under ~/.claude/settings.json.
 */
export function detectClaudeCodeInstalled(
  homeDir: string = homedir(),
  checkExists: (p: string) => boolean = fsExistsSync
): boolean {
  return checkExists(path.join(homeDir, ".claude"));
}

/**
 * Compute which recommended settings keys differ from current values.
 * Handles nested `env` object comparison correctly.
 */
function computeChanges(
  current: Record<string, unknown>,
  recommended: Record<string, unknown>,
  prefix = ""
): HarnessSettingsChange[] {
  const changes: HarnessSettingsChange[] = [];

  for (const key of Object.keys(recommended)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const recommendedValue = recommended[key];
    const currentValue = current[key];

    if (
      typeof recommendedValue === "object" &&
      recommendedValue !== null &&
      !Array.isArray(recommendedValue)
    ) {
      // Recurse into nested object
      const currentNested =
        typeof currentValue === "object" && currentValue !== null && !Array.isArray(currentValue)
          ? (currentValue as Record<string, unknown>)
          : {};
      changes.push(
        ...computeChanges(currentNested, recommendedValue as Record<string, unknown>, fullKey)
      );
    } else if (currentValue !== recommendedValue) {
      changes.push({ key: fullKey, from: currentValue, to: recommendedValue });
    }
  }

  return changes;
}

/**
 * Apply recommended Claude Code agent performance settings to ~/.claude/settings.json.
 *
 * - Reads existing settings.json if present (creates from scratch if absent)
 * - Computes which recommended keys differ from current values
 * - If there are differences: merges and writes (unless dryRun)
 * - If all values already match: reports "already-configured"
 * - If Claude Code not detected: reports "not-detected"
 * - Non-destructive: all existing keys not in the recommended set are preserved
 */
export async function applyClaudeCodeSettings(
  options: ApplyHarnessSettingsOptions = {},
  fileSystem: FsLike = createRealFs()
): Promise<HarnessSettingsResult> {
  const homeDir = options.homeDir ?? homedir();
  const settingsPath = path.join(homeDir, ".claude", "settings.json");

  // Detect Claude Code installation
  if (!detectClaudeCodeInstalled(homeDir, options.checkExists)) {
    return {
      harness: "claude-code",
      status: "not-detected",
      changes: [],
      settingsPath,
    };
  }

  // Read existing settings (or start fresh)
  let current: Record<string, unknown> = {};
  const settingsExists = await fileSystem.exists(settingsPath);
  if (settingsExists) {
    const content = await fileSystem.readFile(settingsPath, "utf-8");
    try {
      current = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Treat unparseable file as empty — we'll merge into it
      current = {};
    }
  }

  // Compute changes
  const changes = computeChanges(current, CLAUDE_CODE_RECOMMENDED_SETTINGS);

  if (changes.length === 0) {
    return {
      harness: "claude-code",
      status: "already-configured",
      changes: [],
      settingsPath,
    };
  }

  // Apply changes (unless dry-run)
  if (!options.dryRun) {
    const merged = deepMergeConfigs(current, CLAUDE_CODE_RECOMMENDED_SETTINGS);
    const settingsDir = path.dirname(settingsPath);
    const dirExists = await fileSystem.exists(settingsDir);
    if (!dirExists) {
      await fileSystem.mkdir(settingsDir, { recursive: true });
    }
    await fileSystem.writeFile(settingsPath, JSON.stringify(merged, null, 2));
  }

  return {
    harness: "claude-code",
    status: "applied",
    changes,
    settingsPath,
  };
}

/**
 * Apply recommended agent performance settings for all detected harnesses.
 *
 * Currently only handles Claude Code. Returns results for each harness that
 * was detected (or skipped as not-detected).
 */
export async function applyHarnessSettings(
  options: ApplyHarnessSettingsOptions = {},
  fileSystem: FsLike = createRealFs()
): Promise<HarnessSettingsResult[]> {
  const results: HarnessSettingsResult[] = [];

  // Claude Code
  const claudeResult = await applyClaudeCodeSettings(options, fileSystem);
  results.push(claudeResult);

  return results;
}
