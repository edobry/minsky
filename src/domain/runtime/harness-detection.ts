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
 */
export type ManagedClient =
  | "cursor"
  | "claude-desktop"
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
 * `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_SUBAGENT_MODEL`,
 * `CLAUDE_CODE_EXECPATH`). It does NOT set bare `CLAUDE_CODE`. Hook contexts
 * additionally set `CLAUDE_PROJECT_DIR`. We accept any of these signals to
 * recognize Claude Code regardless of which surface the MCP server was
 * launched under.
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
    process.env.CLAUDE_PROJECT_DIR ||
    // Legacy variant accepted for backward compatibility — never observed in
    // the wild but kept in case future Claude Code versions or third-party
    // shims set it.
    process.env.CLAUDE_CODE
  ) {
    return "claude-code";
  }

  // Cursor sets various CURSOR_* env vars (it's a VS Code fork)
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
 * Probe the filesystem for installed MCP client applications.
 * Only returns clients that are actually present on this machine.
 *
 * Detection heuristics:
 * - cursor: ~/.cursor/ directory exists
 * - claude-desktop: config directory exists (platform-specific)
 * - vscode: TODO
 */
export function detectInstalledClients(): ManagedClient[] {
  const clients: ManagedClient[] = [];

  // Cursor: check for ~/.cursor/ directory
  if (existsSync(path.join(homedir(), ".cursor"))) {
    clients.push("cursor");
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
  if (existsSync(claudeConfigDir)) {
    clients.push("claude-desktop");
  }

  // VS Code: check for ~/.vscode/ directory
  if (existsSync(path.join(homedir(), ".vscode"))) {
    clients.push("vscode");
  }

  // Windsurf: check for ~/.codeium/ directory
  if (existsSync(path.join(homedir(), ".codeium"))) {
    clients.push("windsurf");
  }

  // Junie (JetBrains): check for ~/.junie/ directory (created by Junie CLI)
  if (existsSync(path.join(homedir(), ".junie"))) {
    clients.push("junie");
  }

  // Codex: check for ~/.codex/ directory
  if (existsSync(path.join(homedir(), ".codex"))) {
    clients.push("codex");
  }

  // OpenHands: skip auto-detection — use --client openhands explicitly
  // OpenHands is an agent framework, not typically installed as a user app.

  return clients;
}
