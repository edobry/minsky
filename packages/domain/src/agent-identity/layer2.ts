/**
 * Layer 2 — Declared identity reader (ADR-006).
 *
 * Reads `_meta["io.minsky/agent_id"]` from MCP request extras.
 * A cooperating caller sets this key on each outgoing MCP request
 * to declare its agentId explicitly.
 *
 * Returns a parsed agentId if the `_meta` key is present and valid,
 * or null if missing or malformed (so the resolver can fall back to Layer 1).
 * Never throws — malformed input silently returns null.
 *
 * Convention key: `io.minsky/agent_id` — namespaced per the `_meta` convention
 * used by Claude Code itself (`claudecode/toolUseId`). See ADR-006 §Layer 2.
 */

import { parseAgentId, type ParsedAgentId } from "./format";

/**
 * The `_meta` key Minsky reads for declared agent identity.
 */
export const AGENT_ID_META_KEY = "io.minsky/agent_id";

/**
 * Shape of MCP RequestHandlerExtra._meta as we observe it.
 * Only the fields we use are typed; extra fields are ignored.
 */
export interface RequestMeta {
  [AGENT_ID_META_KEY]?: unknown;
  progressToken?: unknown;
  [key: string]: unknown;
}

/**
 * Shape of MCP RequestHandlerExtra as exposed by the SDK.
 * Typed conservatively — we only read `_meta`.
 */
export interface RequestExtras {
  _meta?: RequestMeta | unknown;
  sessionId?: string;
  [key: string]: unknown;
}

/**
 * Read and validate a declared agentId from MCP request extras.
 *
 * Returns the parsed agentId if `_meta["io.minsky/agent_id"]` is a
 * non-empty string that passes format validation.
 * Returns null in all other cases (no _meta, wrong type, malformed format).
 */
export function readLayer2(extras: RequestExtras | undefined): ParsedAgentId | null {
  if (!extras) return null;

  // Safely extract _meta — may be absent or non-object
  const meta = extras._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;

  const declared = (meta as RequestMeta)[AGENT_ID_META_KEY];
  if (typeof declared !== "string" || declared.length === 0) return null;

  // Delegate to format parser — returns null if malformed
  return parseAgentId(declared);
}
