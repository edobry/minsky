/**
 * Agent harness detection.
 *
 * Minsky is agent-harness-independent: it detects which runtime it's
 * operating in and adapts behavior accordingly. Native subagent capacity
 * is used when available; Minsky's own loop is the fallback.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import * as path from "path";

export type AgentHarness = "claude-code" | "cursor" | "standalone";

/**
 * The set of MCP client applications that Minsky can register itself with.
 * Extend this union as new clients are implemented.
 *
 * `openhands` is included for the `--client openhands` registration code path
 * but is intentionally excluded from `detectInstalledClients()` auto-detection
 * (no reliable filesystem signature; it's an agent framework rather than a
 * user-installed app). Callers must opt in explicitly.
 *
 * `claude-code` (mt#4676) is registered at USER scope (`~/.claude.json`'s
 * top-level `mcpServers` key), not per-project — see `ClaudeCodeRegistrar`
 * in `../mcp/registration.ts` for why.
 */
export type ManagedClient =
  | "cursor"
  | "claude-desktop"
  | "claude-code"
  | "vscode"
  | "windsurf"
  | "junie"
  | "codex"
  | "openhands";

/**
 * Detect the current agent harness from environment signals.
 *
 * Claude Code 2.1.x sets `CLAUDECODE=1` (no underscore) plus a family of
 * `CLAUDE_CODE_*`-namespaced vars (`CLAUDE_CODE_ENTRYPOINT`,
 * `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_EXECPATH`). It does NOT set bare
 * `CLAUDE_CODE`. Hook contexts additionally set `CLAUDE_PROJECT_DIR`. We
 * accept any of these signals to recognize Claude Code regardless of which
 * surface the MCP server was launched under.
 *
 * `CLAUDE_CODE_SUBAGENT_MODEL` is also accepted below, but do NOT count it as
 * a harness signal (mt#3151): it was listed here as one because this repo's
 * own `.claude/settings.json` set it, so its presence was self-inflicted —
 * the check was reading our config, not detecting Claude Code. That pin was
 * removed, and whether the harness sets the variable on its own is not
 * established either way; the first session after the removal settles it. The
 * accepted-signal list keeps it because it costs nothing (any one of the
 * signals above already identifies the harness) and dropping it is a separate
 * cleanup, but nothing should rely on it.
 *
 * Detection priority:
 * 1. Any Claude Code env signal → Claude Code
 * 2. CURSOR_* env vars or VS Code fork context → Cursor
 * 3. Neither → standalone / unknown
 */
export function detectAgentHarness(): AgentHarness {
  if (
    process.env.CLAUDECODE ||
    process.env.CLAUDE_CODE_ENTRYPOINT ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.CLAUDE_CODE_SUBAGENT_MODEL ||
    process.env.CLAUDE_CODE_EXECPATH ||
    process.env.CLAUDE_PROJECT_DIR ||
    // Legacy variant accepted for backward compatibility — never observed in
    // the wild but kept in case future Claude Code versions or third-party
    // shims set it.
    process.env.CLAUDE_CODE
  ) {
    return "claude-code";
  }

  // Cursor sets CURSOR_SESSION_ID / CURSOR_TRACE_ID; both Cursor and stock VS
  // Code set VSCODE_PID (Cursor is a VS Code fork). Treating VSCODE_PID alone
  // as "cursor" is intentional — for our purposes (native subagent support
  // detection at hasNativeSubagentSupport() and downstream prompt-generation
  // dispatch), VS Code and Cursor are equivalent: neither has native subagent
  // support yet, so both fall through to the standalone-style fat-prompt path.
  // If future native-subagent support diverges between the two, split this
  // branch and rename the harness label.
  if (process.env.CURSOR_SESSION_ID || process.env.CURSOR_TRACE_ID || process.env.VSCODE_PID) {
    return "cursor";
  }

  return "standalone";
}

/**
 * Whether the current harness supports native subagent dispatch.
 * When true, Minsky returns prompts for the harness to dispatch.
 * When false, Minsky would need its own agent loop (not yet implemented).
 */
export function hasNativeSubagentSupport(): boolean {
  const harness = detectAgentHarness();
  return harness === "claude-code"; // Cursor support TBD
}

/**
 * Injectable dependency for `detectInstalledClients()` — lets tests supply a
 * deterministic path-existence check instead of probing the real filesystem
 * (per `testing-standards.mdc §Testable Design`: inject the collaborator
 * rather than patching `fs.existsSync` in place).
 */
export interface DetectInstalledClientsDeps {
  /** Returns whether a filesystem path exists. Defaults to `fs.existsSync`. */
  pathExists?: (path: string) => boolean;
}

/**
 * Probe the filesystem for installed MCP client applications.
 * Only returns clients that are actually present on this machine.
 *
 * Detection heuristics:
 * - cursor: ~/.cursor/ directory exists
 * - claude-desktop: config directory exists (platform-specific)
 * - claude-code: ~/.claude/ directory exists (created on first run; holds
 *   settings, credentials, conversation history — same signature class as
 *   cursor's ~/.cursor/)
 * - vscode: TODO
 */
export function detectInstalledClients(deps: DetectInstalledClientsDeps = {}): ManagedClient[] {
  const pathExists = deps.pathExists ?? existsSync;
  const clients: ManagedClient[] = [];

  // Cursor: check for ~/.cursor/ directory
  if (pathExists(path.join(homedir(), ".cursor"))) {
    clients.push("cursor");
  }

  // Claude Code: check for ~/.claude/ directory
  if (pathExists(path.join(homedir(), ".claude"))) {
    clients.push("claude-code");
  }

  // Claude Desktop: check for platform-specific config directory
  const home = homedir();
  let claudeConfigDir: string;
  if (process.platform === "darwin") {
    claudeConfigDir = path.join(home, "Library", "Application Support", "Claude");
  } else if (process.platform === "win32") {
    claudeConfigDir = path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      "Claude"
    );
  } else {
    claudeConfigDir = path.join(home, ".config", "Claude");
  }
  if (pathExists(claudeConfigDir)) {
    clients.push("claude-desktop");
  }

  // VS Code: check for ~/.vscode/ directory
  if (pathExists(path.join(homedir(), ".vscode"))) {
    clients.push("vscode");
  }

  // Windsurf: check for ~/.codeium/ directory
  if (pathExists(path.join(homedir(), ".codeium"))) {
    clients.push("windsurf");
  }

  // Junie (JetBrains): check for ~/.junie/ directory (created by Junie CLI)
  if (pathExists(path.join(homedir(), ".junie"))) {
    clients.push("junie");
  }

  // Codex: check for ~/.codex/ directory
  if (pathExists(path.join(homedir(), ".codex"))) {
    clients.push("codex");
  }

  // OpenHands: skip auto-detection — use --client openhands explicitly
  // OpenHands is an agent framework, not typically installed as a user app.

  return clients;
}

/**
 * Resolve which MCP client `minsky init` should register with and record as
 * this workspace's `harness` (mt#4676).
 *
 * Prefers the environment-reported harness (`detectAgentHarness()`) — the
 * running agent's own signal about what it currently IS — over filesystem
 * installed-ness (`detectInstalledClients()`), which only proves an
 * application is present on this machine, not that it is the one driving
 * `init` right now. `detectInstalledClients()` is consulted only as a
 * fallback, when the environment gives no signal at all (`standalone`) —
 * mirroring the interactive `setup` command's own multi-client fallback
 * (`src/adapters/shared/commands/setup.ts`), minus the interactive prompt:
 * the first detected client wins, or `cursor` when none are detected
 * (preserving `init`'s pre-mt#4676 default).
 *
 * `harness` and `installedClients` are accepted as parameters — defaulting
 * to the real detectors — rather than read internally, so the exact
 * ambiguous case this function exists to resolve (an env signal AND a
 * filesystem signal both present, and disagreeing) is testable without
 * mutating `process.env` or the filesystem.
 */
export function resolveInitClient(
  harness: AgentHarness = detectAgentHarness(),
  installedClients: ManagedClient[] = detectInstalledClients()
): ManagedClient {
  if (harness === "claude-code") return "claude-code";
  if (harness === "cursor") return "cursor";
  return installedClients[0] ?? "cursor";
}
