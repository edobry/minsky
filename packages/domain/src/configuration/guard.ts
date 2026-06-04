/**
 * Project Setup Guard
 *
 * Provides a guard function that verifies a project has been properly initialized
 * before commands are executed. Throws actionable errors when setup is incomplete.
 */

import { existsSync } from "fs";
import * as path from "path";
import { ValidationError } from "../errors/index";

/**
 * Set of command IDs that are exempt from the project setup guard.
 * These commands are responsible for initialization themselves, or are
 * infrastructure commands that must work without a configured project.
 */
export const EXEMPT_COMMANDS = new Set(["init", "setup", "mcp.register"]);

/**
 * Session commands that are served entirely from the shared task DB or the
 * GitHub API and therefore work against the hosted HTTP MCP server, which
 * ships no `git` and has no local session workspace (mt#1601).
 *
 * This is an ALLOWLIST: in hosted mode every `git.*` command and every
 * `session.*` command NOT in this set is rejected with a documented error
 * (see `guardHostedCapability`). The list is intentionally fail-closed —
 * a false *allow* would reach the `git clone` / workspace access that fails
 * with the raw `/bin/sh: 1: git: not found`, which is the exact bad UX this
 * guard exists to replace; a false *block* merely returns a clean "use the
 * local server" message. New session commands are therefore blocked-on-hosted
 * by default until explicitly verified to be DB/API-only and added here.
 *
 * Every entry below was verified to touch only the session DB record or the
 * GitHub API, never the local session workspace or `git` CLI.
 */
export const HOSTED_SAFE_SESSION_COMMANDS = new Set([
  "session.get", // DB record lookup
  "session.list", // DB list
  "session.dir", // DB path lookup (string only; no fs/git access)
  "session.search", // DB listSessions + in-memory filter
  "session.inspect", // DB record inspection
  "session.pr.list", // GitHub API
  "session.pr.get", // GitHub API / DB
  "session.pr.checks", // GitHub API check-runs
  "session.changeset.list", // DB / GitHub API
  "session.changeset.get", // DB / GitHub API
  "session.cs.list", // alias of changeset.list
  "session.cs.get", // alias of changeset.get
]);

/**
 * Hosted-mode flag. When true, `guardProjectSetup` skips the local-setup
 * nudge but still enforces the hosted-capability guard (mt#1601).
 *
 * The setup guard exists to nudge developers on their laptops into running
 * `minsky setup` so their MCP harness (Cursor/Claude/etc.) gets registered.
 * That intent does not apply to a hosted HTTP MCP server — no harness to
 * register, no developer to nag — so we skip that nudge there (mt#1208). But
 * hosted has a NARROWER capability set than local: it ships no `git` and has
 * no session workspace, so git/workspace-requiring commands must fail fast
 * with a documented error rather than the raw `git: not found` (mt#1601).
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
 * Reject git/workspace-requiring commands when running on the hosted HTTP MCP
 * server, which ships no `git` and has no local session workspace (mt#1601).
 *
 * Without this guard, such commands reach a `git clone` / workspace access that
 * fails with a raw `/bin/sh: 1: git: not found`, which is opaque to the caller.
 * Instead we throw a documented `ValidationError` naming the command and the
 * local server as the supported path.
 *
 * Unsupported on hosted:
 *  - every `git.*` command (no `git` binary, no local repo on hosted), and
 *  - every `session.*` command NOT in `HOSTED_SAFE_SESSION_COMMANDS`
 *    (session creation, commit, update, exec, file edits, PR push, changeset
 *    branch ops, etc. — all need the local workspace / `git`).
 *
 * Commands outside the `git.*` / `session.*` namespaces are unaffected, as are
 * the DB/API-served session reads in the allowlist.
 *
 * NOTE: this covers the shared-command-registry surface (session + git
 * commands all dispatch through `guardProjectSetup`). The separately-registered
 * session FILE tools (`session_read_file` / `session_write_file` / etc. in
 * `adapters/mcp/session-files.ts`) bypass this chokepoint; on hosted they fail
 * with a filesystem ENOENT rather than a `git` error. Extending the same
 * documented-error treatment to that path is a fast-follow (see mt#1601 spec).
 *
 * @param commandId - The command ID being dispatched
 * @throws {ValidationError} When the command is unsupported on hosted
 */
export function guardHostedCapability(commandId: string): void {
  const isGitCommand = commandId === "git" || commandId.startsWith("git.");
  const isSessionCommand = commandId === "session" || commandId.startsWith("session.");
  const isUnsupportedSessionCommand =
    isSessionCommand && !HOSTED_SAFE_SESSION_COMMANDS.has(commandId);

  if (isGitCommand || isUnsupportedSessionCommand) {
    throw new ValidationError(
      `Command '${commandId}' is not supported on the hosted Minsky MCP server. ` +
        `Hosted is an HTTP MCP / metadata-only surface: it ships no 'git' and has ` +
        `no local session workspace, so session and workspace operations must run ` +
        `against the local 'minsky mcp' server. Use the local server for this command.`
    );
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
    // Hosted skips the local-setup nudge but still enforces the narrower
    // hosted capability set: git/workspace ops fail fast with a documented
    // error instead of the raw `git: not found` (mt#1601).
    guardHostedCapability(commandId);
    return;
  }

  if (EXEMPT_COMMANDS.has(commandId)) {
    return;
  }

  checkProjectSetup(repoPath ?? process.cwd(), deps);
}
