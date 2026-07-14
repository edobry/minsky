/**
 * Tool-name normalization for the cockpit's per-tool renderer registries (mt#2787).
 *
 * Claude Code transcripts carry MCP tool names in the harness-prefixed form
 * `mcp__<server>__<tool>` (e.g. `mcp__minsky__tasks_list`); harness-native tools
 * are unprefixed (`Bash`, `Read`). Registries (e.g. ToolPayload's Tier-3
 * `TOOL_RESULT_RENDERERS`) key on the BARE tool name, so lookups must parse the
 * raw transcript name first — without this, a bare-keyed registry never matches
 * real transcript data (the mt#2787 bug).
 *
 * Server scoping is preserved in the parse result rather than discarded: today
 * the renderer set is single-server (minsky) so bare-name keying is unambiguous,
 * but if a second server ever ships a colliding tool name, registries can move
 * to `server`-qualified keys without re-parsing call sites.
 */

export interface ParsedToolName {
  /** MCP server name when harness-prefixed (`mcp__minsky__x` → `"minsky"`); null for native tools. */
  server: string | null;
  /** Bare tool name (`tasks_list`, `Bash`). */
  name: string;
}

// Lazy server match: the server segment ends at the FIRST `__` boundary, so a
// tool name that itself starts with `__` (e.g. `mcp__minsky____proxy_restart_server`
// → server "minsky", tool "__proxy_restart_server") parses correctly.
const MCP_NAME_RE = /^mcp__(.+?)__(.+)$/;

/** Parse a raw transcript tool name into its server + bare-name parts. */
export function parseToolName(raw: string): ParsedToolName {
  const m = MCP_NAME_RE.exec(raw);
  if (m) return { server: m[1], name: m[2] };
  return { server: null, name: raw };
}
