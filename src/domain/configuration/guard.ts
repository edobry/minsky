/**
 * Project Setup Guard
 *
 * Provides a guard function that verifies a project has been properly initialized
 * before commands are executed. Throws actionable errors when setup is incomplete.
 */

import { existsSync } from "fs";
import * as path from "path";
import { ValidationError } from "../../errors/index";

/**
 * Set of command IDs that are exempt from the project setup guard.
 * These commands are responsible for initialization themselves, or are
 * infrastructure commands that must work without a configured project.
 */
export const EXEMPT_COMMANDS = new Set(["init", "setup", "mcp.register"]);

/**
 * Hosted-mode flag. When true, `guardProjectSetup` is a no-op.
 *
 * The setup guard exists to nudge developers on their laptops into running
 * `minsky setup` so their MCP harness (Cursor/Claude/etc.) gets registered.
 * That intent does not apply to a hosted HTTP MCP server — no harness to
 * register, no developer to nag — so we skip the guard there. See mt#1208.
 */
let hostedMode = false;

/**
 * Enable or disable hosted mode. Called by the MCP `start` command when it
 * is launched with `--http`. No-op for stdio / CLI invocations.
 */
export function setHostedMode(enabled: boolean): void {
  hostedMode = enabled;
}

/**
 * Test hook — returns the current hosted-mode flag. Not intended for
 * production callers; the guard consults the flag internally.
 */
export function isHostedMode(): boolean {
  return hostedMode;
}

/**
 * Dependencies for the project setup guard (injectable for testing).
 */
export interface GuardDeps {
  existsSync: (path: string) => boolean;
}

/**
 * Detect whether `repoPath` is a Minsky session directory.
 *
 * Session directories are isolated git clones that don't have `.minsky/config.local.yaml`
 * (it's gitignored), so the local config check must be skipped for them.
 */
function isSessionDirectory(repoPath: string): boolean {
  return repoPath.includes("/.local/state/minsky/sessions/");
}

/**
 * Check whether the project at `repoPath` has been properly initialized.
 *
 * - Missing `.minsky/config.yaml` → error with "minsky init" guidance
 * - Missing `.minsky/config.local.yaml` (when config.yaml exists and not in session) → error with "minsky setup" guidance
 * - Both files present (or in a session directory) → no error
 *
 * @param repoPath - Path to the project root
 * @param deps     - Injectable dependencies (defaults to real fs)
 * @throws {ValidationError} When project setup is incomplete
 */
export function checkProjectSetup(repoPath: string, deps: GuardDeps = { existsSync }): void {
  const configPath = path.join(repoPath, ".minsky", "config.yaml");
  const localConfigPath = path.join(repoPath, ".minsky", "config.local.yaml");

  if (!deps.existsSync(configPath)) {
    throw new ValidationError("This project hasn't been initialized. Run `minsky init` first.");
  }

  // Skip the local config check when running inside a session directory.
  // Session directories are isolated git clones where config.local.yaml is gitignored.
  if (!isSessionDirectory(repoPath) && !deps.existsSync(localConfigPath)) {
    throw new ValidationError("Developer setup incomplete. Run `minsky setup` first.");
  }
}

/**
 * Run the project setup guard unless the command is exempt.
 *
 * @param commandId - The command ID being executed
 * @param repoPath  - Path to the project root (defaults to process.cwd())
 * @param deps      - Injectable dependencies (defaults to real fs)
 */
export function guardProjectSetup(commandId: string, repoPath?: string, deps?: GuardDeps): void {
  if (hostedMode) {
    return;
  }

  if (EXEMPT_COMMANDS.has(commandId)) {
    return;
  }

  checkProjectSetup(repoPath ?? process.cwd(), deps);
}
