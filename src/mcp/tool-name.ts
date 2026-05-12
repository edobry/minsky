/**
 * MCP tool-name normalization helpers (mt#1779).
 *
 * Lives in its own module to avoid circular imports between `command-mapper.ts`
 * (registers tools) and `server.ts` (emits / dispatches by name).
 */

/**
 * Produce a Claude-Desktop-validator-compatible variant of a tool name.
 *
 * Claude Desktop's frontend validator regex is `^[a-zA-Z0-9_-]{1,64}$` —
 * strictly no dots. Tool names like `tasks.list` or `session.pr.get` fail
 * validation and the entire `tools/list` response is rejected, blocking every
 * tool call from Claude Desktop. Replace dots with underscores so the name
 * passes the validator.
 *
 * The replacement is one-way; duplicate detection lives at registration time
 * in `MinskyMCPServer.addTool` (a theoretical collision — canonical `foo.bar`
 * meeting an existing `foo_bar` — would surface there and refuse to overwrite).
 */
export function toClaudeDesktopName(methodName: string): string {
  return methodName.replace(/\./g, "_");
}

/**
 * mt#1779 PR #1071 R1 BLOCKING #2: feature-detect strict-validator clients.
 *
 * Returns true when `tools/list` should emit underscored names instead of
 * canonical dotted names. Avoids a silent wire-contract change for non-Claude
 * clients that discover tools via `tools/list` and then call by the returned
 * `name`. The override env var `MINSKY_MCP_TOOL_NAMES` forces specific
 * behavior:
 *   - `"underscore"` → always emit underscored
 *   - `"dotted"` → always emit canonical (the pre-mt#1779 behavior; will fail
 *     against Claude Desktop)
 *   - unset or `"auto"` → feature-detect from clientInfo.name (default)
 *
 * Auto-detection: case-insensitive prefix match `claude*` against
 * `clientInfo.name`. Covers Claude Desktop, claude.ai web, Claude Code CLI,
 * and any future Anthropic-emitted MCP client. Other clients (e.g., custom
 * MCP clients, OpenAI's, the Reviewer service if it ever uses `tools/list`)
 * see the canonical dotted form they may already expect.
 */
export function shouldEmitDesktopAliases(
  clientInfo: { name?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const override = (env.MINSKY_MCP_TOOL_NAMES ?? "auto").toLowerCase();
  if (override === "underscore") return true;
  if (override === "dotted") return false;
  // auto — feature-detect
  const name = clientInfo?.name;
  if (!name) return false;
  return name.toLowerCase().startsWith("claude");
}
