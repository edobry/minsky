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
