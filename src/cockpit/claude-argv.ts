/**
 * Claude CLI argv builders (mt#4934 PR #3594 R1) — the documented headless
 * invocation (mt#2750 spec Context — Claude Code headless docs,
 * code.claude.com/docs/en/headless). Factored out of ./claude-transport.ts
 * as its own module so that file stays under the 400-line warning after
 * gaining `stop`/`isAlive` (PR #3594 R1) — argv construction is a
 * self-contained concern independent of the spawn/wire mechanics that stay
 * in claude-transport.ts.
 *
 * @see mt#4934 — the transport split
 * @see ./claude-transport.ts — the transport that calls these
 */

import { mcpConfigArgs } from "./driven-session-mcp-config";
import type { PermissionMode } from "./driver-transport";

/** The genuine binary this transport spawns. Never anything from `@anthropic-ai/*`. */
export const CLAUDE_BINARY = "claude";

export function permissionModeArgs(mode: PermissionMode): string[] {
  return mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : [];
}

/** `-p` is required for `--input-format stream-json`; `--output-format
 * stream-json` for structured output; `--verbose` for the full event stream;
 * `--include-partial-messages` for token deltas (`stream_event`). */
export function buildDrivenSessionArgs(
  permissionMode: PermissionMode,
  model?: string,
  mcpConfig?: string | null
): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // mt#3040: principal-selected model (a resolved dispatch alias, e.g. "fable").
    // Omitted → the genuine claude binary resolves its own default.
    ...(model ? ["--model", model] : []),
    // mt#3377: provision the minsky MCP server explicitly. Without this the
    // child resolves MCP servers against its cwd (a session workspace), which
    // carries none — see ./driven-session-mcp-config.ts.
    ...mcpConfigArgs(mcpConfig),
    ...permissionModeArgs(permissionMode),
  ];
}

/**
 * The resume-spawn invocation (mt#3038, RFC "Conversation-first drive"
 * Phase 1): identical to {@link buildDrivenSessionArgs} plus `--resume
 * <harnessSessionId>`, which resumes the CLI's own on-disk transcript for
 * that conversation id rather than starting a fresh one. This is the ONLY
 * difference between a fresh spawn and a restart-recovery respawn — the
 * durable entity is the conversation (the RFC's thesis), and the session
 * driver (child process) is disposable.
 *
 * Unchanged in behaviour by mt#4934 — the same argv, in the same order, for
 * the same inputs, as before the split (SC2).
 */
export function buildResumeSessionArgs(
  permissionMode: PermissionMode,
  harnessSessionId: string,
  model?: string | null,
  mcpConfig?: string | null
): string[] {
  return [
    "-p",
    "--resume",
    harnessSessionId,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // mt#3040 preservation: a resume must keep the ORIGINALLY-selected model
    // rather than silently falling back to the CLI's default.
    ...(model ? ["--model", model] : []),
    // mt#3377: a resumed session driver needs the same server set as a fresh spawn —
    // the conversation is durable, the process is disposable, and a resume
    // that silently dropped the MCP servers would degrade mid-conversation.
    ...mcpConfigArgs(mcpConfig),
    ...permissionModeArgs(permissionMode),
  ];
}
