/**
 * The CALLER's actor identity, as seen by a registered command.
 *
 * Extracted in mt#4568 from `observability.calibration-review`'s private copy
 * (mt#4408), because `tasks.claims.release` needs exactly the same resolution
 * and a second copy of an identity rule is the failure mode this resolution
 * exists to end — the same "one source of truth" constraint mt#4440 SC3 states
 * for the presence-claim writer.
 *
 * ## Why the ordering is not arbitrary
 *
 * The server-injected value wins because the two env vars below belong to the
 * Claude Code HARNESS process. An MCP tool call executes inside the long-lived
 * Minsky MCP server — a daemon started before the conversation existed — so it
 * can never carry that conversation's id.
 *
 * Measured 2026-08-21 (mt#4408): the same calibration sweep returned
 * `claimsUnavailable: true` over MCP and `false` over the CLI, minutes apart,
 * against the same store. The difference was the PROCESS, not the state. That
 * made the mt#4164 claim inert on the invocation path every pass actually uses,
 * with no warning on either side — a mechanism verified on one invocation path
 * is not verified (mem#1184).
 *
 * So both branches are load-bearing and neither is a fallback for the other:
 *
 * - **MCP path** — `callerActorId` is injected by the server for tools listed in
 *   `CALLER_ACTOR_ID_TOOL_NAMES` (`src/mcp/server.ts`). A command that reads this
 *   helper without being added to that set gets `null` on every MCP call while
 *   working perfectly over the CLI.
 * - **CLI path** — no injection happens, and none is needed: the CLI runs as a
 *   child of the harness, so its environment names the current conversation.
 *
 * ## Why `null` rather than an invented id
 *
 * A claim whose holder cannot be named is worse than no claim — a second actor
 * would see it, stand down, and have nobody to attribute the work to. An
 * unidentifiable caller therefore fails open (claims nothing, releases nothing)
 * and says so in its result.
 *
 * @param callerActorId Server-injected identity, when the transport supplied one.
 * @returns The resolved ADR-006 agent id, or `null` when no source names one.
 */
export function resolveCallerActorId(callerActorId?: string): string | null {
  if (callerActorId && callerActorId.trim()) return callerActorId.trim();
  const agentId = process.env.CLAUDE_AGENT_ID;
  if (agentId && agentId.trim()) return agentId.trim();
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (sessionId && sessionId.trim()) return `com.anthropic.claude-code:conv:${sessionId.trim()}`;
  return null;
}
