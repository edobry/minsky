// Types for Claude Code hook stdin/stdout contract
// Utility: spawnSync wrapper that returns { exitCode, stdout, stderr } without throwing

export interface ClaudeHookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: string;
  agent_id?: string;
}

export interface ToolHookInput extends ClaudeHookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_result?: Record<string, unknown>;
}

export interface StopHookInput extends ClaudeHookInput {
  reason?: string;
  stop_hook_active?: boolean;
}

export interface HookOutput {
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
  };
}

// Sync exec helper — returns exit code + output without throwing
export function execSync(
  cmd: string[],
  options?: { cwd?: string; timeout?: number }
): { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } {
  const result = Bun.spawnSync(cmd, {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options?.timeout,
  });
  const timedOut = result.exitCode === null && result.signalCode === "SIGTERM";
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    timedOut,
  };
}

/**
 * PATH-augmented sync exec helper. Prepends common homebrew/system binary
 * directories to PATH so that `gh` and `git` resolve correctly regardless of
 * the shell PATH that launched Claude Code. Used by hooks that call `gh`/`git`.
 */
export function execWithPath(
  cmd: string[],
  options?: { cwd?: string; timeout?: number }
): { exitCode: number; stdout: string; stderr: string; timedOut?: boolean } {
  const pathPrefix = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`;
  const result = Bun.spawnSync(cmd, {
    cwd: options?.cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options?.timeout ?? 10000,
    env: { ...process.env, PATH: pathPrefix },
  });
  const timedOut = result.exitCode === null && result.signalCode === "SIGTERM";
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    timedOut,
  };
}

// Read hook input from stdin
export async function readInput<T = ClaudeHookInput>(): Promise<T> {
  return (await Bun.stdin.json()) as T;
}

// Write hook output to stdout
export function writeOutput(output: HookOutput): void {
  process.stdout.write(JSON.stringify(output));
}

// ---------------------------------------------------------------------------
// Host-cap reader (mt#1546)
// ---------------------------------------------------------------------------
//
// PreToolUse/PostToolUse hooks declare a host-imposed `timeout` in
// `.claude/settings.json` — Claude Code SIGKILLs the hook after that many
// seconds. Hooks that run multiple bounded calls inside that window need their
// internal budgets to stay under the cap. Hardcoding ms values per-hook drifts
// silently when the cap is bumped; reading the cap at startup keeps the
// relationship structural.
//
// `readHostCap` walks `hooks.<event>[*].hooks[*].command` for the entry that
// references this hook's filename and returns its `timeout` field.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_HOST_CAP_SEC = 15;

export interface HostCapInfo {
  /** Resolved host cap in seconds. */
  hostCapSec: number;
  /** Where the cap came from. */
  source: "settings.json" | "default";
  /**
   * Set on every fallback path (project dir undetectable, settings.json missing
   * or malformed, no matcher entry, missing/invalid timeout). Unset on the
   * happy path. Hooks should surface the warning through their existing
   * operator-warning channel (e.g., the `warnings` array emitted as
   * `additionalContext`).
   */
  warning?: string;
}

/**
 * Read the host-imposed timeout cap (in seconds) for the matcher entry that
 * runs this hook.
 *
 * @param hookFilename — substring used to match against each hook entry's
 *   `command` field. The simplest invocation is the bare basename
 *   (`"check-branch-fresh.ts"`); the substring match also tolerates
 *   `$CLAUDE_PROJECT_DIR`-prefixed paths and other prefixes.
 * @param projectDir — optional override. When omitted, falls back to
 *   `process.env.CLAUDE_PROJECT_DIR`.
 * @param readFile — optional file-reader adapter. Default reads via
 *   `node:fs.readFileSync`; tests inject a fake reader to keep tests pure
 *   (no real filesystem coupling).
 *
 * Falls back to `DEFAULT_HOST_CAP_SEC` (15s) on any failure path with a
 * descriptive `warning` set.
 */
export function readHostCap(
  hookFilename: string,
  projectDir?: string,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8")
): HostCapInfo {
  const root = projectDir ?? process.env["CLAUDE_PROJECT_DIR"] ?? null;
  if (!root) {
    return {
      hostCapSec: DEFAULT_HOST_CAP_SEC,
      source: "default",
      warning:
        "CLAUDE_PROJECT_DIR not set and no projectDir override — using default host cap (15s)",
    };
  }

  const settingsPath = join(root, ".claude", "settings.json");
  let raw: string;
  try {
    raw = readFile(settingsPath);
  } catch (err) {
    return {
      hostCapSec: DEFAULT_HOST_CAP_SEC,
      source: "default",
      warning: `Could not read ${settingsPath}: ${err instanceof Error ? err.message : String(err)} — using default host cap (15s)`,
    };
  }

  return findHostCapInSettings(raw, hookFilename, settingsPath);
}

/**
 * Pure JSON-walker: given the contents of `.claude/settings.json` (already
 * read from disk), find the matcher entry whose `command` includes
 * `hookFilename` and return its `timeout` field.
 *
 * Split out from `readHostCap` so tests can exercise the parse + walk +
 * validate paths without touching the real filesystem.
 */
export function findHostCapInSettings(
  raw: string,
  hookFilename: string,
  settingsPathForErrors = ".claude/settings.json"
): HostCapInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      hostCapSec: DEFAULT_HOST_CAP_SEC,
      source: "default",
      warning: `Could not parse ${settingsPathForErrors}: ${err instanceof Error ? err.message : String(err)} — using default host cap (15s)`,
    };
  }

  // Walk hooks.<event>[*].hooks[*].command for a substring match. Settings
  // shape: { hooks: { PreToolUse: [{ matcher, hooks: [{ command, timeout }] }] } }.
  const settings = parsed as { hooks?: Record<string, unknown> };
  const allEvents = settings.hooks ?? {};
  for (const eventEntries of Object.values(allEvents)) {
    if (!Array.isArray(eventEntries)) continue;
    for (const matcherEntry of eventEntries) {
      if (!matcherEntry || typeof matcherEntry !== "object") continue;
      const matcher = matcherEntry as { hooks?: unknown };
      if (!Array.isArray(matcher.hooks)) continue;
      for (const hookDef of matcher.hooks) {
        if (!hookDef || typeof hookDef !== "object") continue;
        const def = hookDef as { command?: unknown; timeout?: unknown };
        if (typeof def.command !== "string") continue;
        if (!def.command.includes(hookFilename)) continue;
        if (typeof def.timeout !== "number" || !Number.isFinite(def.timeout) || def.timeout <= 0) {
          return {
            hostCapSec: DEFAULT_HOST_CAP_SEC,
            source: "default",
            warning: `Settings entry for ${hookFilename} has missing/invalid timeout — using default host cap (15s)`,
          };
        }
        return { hostCapSec: def.timeout, source: "settings.json" };
      }
    }
  }

  return {
    hostCapSec: DEFAULT_HOST_CAP_SEC,
    source: "default",
    warning: `No matcher entry found referencing ${hookFilename} — using default host cap (15s)`,
  };
}
