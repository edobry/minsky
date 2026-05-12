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
 * Decide whether `tools/list` should emit the underscored Claude-Desktop alias
 * or the canonical dotted name.
 *
 * mt#1785: the default is `"underscore"` — always emit Claude-Desktop-compatible
 * names. The previous default (`"auto"`, feature-detect via `clientInfo.name`)
 * shipped in mt#1779 but proved insufficient against Anthropic's server-side
 * tools-list cache. The cache is keyed by MCP-server name; once it captures a
 * dotted-name snapshot from any path that misses our feature-detect (e.g., a
 * client invocation whose `clientInfo.name` doesn't begin with "claude"), the
 * chat session continues to serve the cached dotted names regardless of what
 * subsequent `tools/list` fetches return. Emitting underscored unconditionally
 * means EVERY snapshot Anthropic might cache is validator-clean.
 *
 * Env var `MINSKY_MCP_TOOL_NAMES` modes:
 *   - `"underscore"` (default) — always emit underscored
 *   - `"dotted"` — always emit canonical (pre-mt#1779 behavior; will fail
 *     against Claude Desktop's strict-validator path)
 *   - `"auto"` — feature-detect from `clientInfo.name` (mt#1779 behavior;
 *     case-insensitive `claude*` prefix match)
 *
 * Note: `tool.name` (used internally by `DI_FREE_TOOL_NAMES`, drift gate,
 * and log lines) keeps the canonical dotted form regardless of this setting.
 * The dual-registered map in `MinskyMCPServer.addTool` ensures CallTool
 * dispatch resolves either name form, so dotted-name consumers continue to
 * work whatever this setting emits.
 */
export function shouldEmitDesktopAliases(
  clientInfo: { name?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const mode = (env.MINSKY_MCP_TOOL_NAMES ?? "underscore").toLowerCase();
  if (mode === "underscore") return true;
  if (mode === "dotted") return false;
  // auto — feature-detect (case-insensitive `claude*` prefix on clientInfo.name)
  const name = clientInfo?.name;
  if (!name) return false;
  return name.toLowerCase().startsWith("claude");
}
