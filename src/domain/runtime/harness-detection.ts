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
export type ManagedClient = "cursor" | "claude-desktop" | "vscode";

/**
 * Detect the current agent harness from environment signals.
 *
 * Detection priority:
 * 1. CLAUDE_CODE env var → Claude Code
 * 2. CURSOR_* env vars or VS Code fork context → Cursor
 * 3. Neither → standalone / unknown
 */
export function detectAgentHarness(): AgentHarness {
  // Claude Code sets CLAUDE_CODE=1 or CLAUDE_PROJECT_DIR in the agent environment
  if (process.env.CLAUDE_CODE || process.env.CLAUDE_PROJECT_DIR) {
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
 * - claude-desktop: TODO (~/Library/Application Support/Claude/ on macOS)
 * - vscode: TODO
 */
export function detectInstalledClients(): ManagedClient[] {
  const clients: ManagedClient[] = [];

  // Cursor: check for ~/.cursor/ directory
  if (existsSync(path.join(homedir(), ".cursor"))) {
    clients.push("cursor");
  }

  // TODO: claude-desktop — check ~/Library/Application Support/Claude/ on macOS
  // TODO: vscode — check ~/.vscode/ or platform-specific VS Code config dirs

  return clients;
}
