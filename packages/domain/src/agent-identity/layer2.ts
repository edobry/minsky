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
 * The handler context the SDK hands a request handler, typed conservatively —
 * we only read the request's `_meta` (and `sessionId`).
 *
 * TWO shapes, because the SDK changed under us (mt#5160):
 *
 * - **v1 `RequestHandlerExtra`** — flat: `extra._meta`. Hand-built fixtures in
 *   this repo still use this shape, and the stdio path did until mt#4854.
 * - **v2 `BaseContext`** (`@modelcontextprotocol/server` 2.0.0, in service since
 *   mt#4854 merged 2026-09-01) — structured: the request's `_meta` sits at
 *   `ctx.mcpReq._meta`, with the reserved `io.modelcontextprotocol/*` envelope
 *   keys lifted out; `sessionId` stayed top-level. The SDK's own
 *   `contextPropertyMap.ts` is the source of truth for the move.
 *
 * Reading only the v1 field against a v2 ctx does not throw — it reads
 * `undefined`, so every declared identity silently fell through to Layer 1 for
 * two weeks while the shim stamped correctly (mt#4667's four failed
 * verifications; the daemon log's 93 `fell back to Layer 1` lines and zero
 * `layerThatAnswered: 2`). `requestMetaOf` is the one place both shapes are
 * read, so a reader cannot pick the wrong one again.
 */
export interface RequestExtras {
  _meta?: RequestMeta | unknown;
  mcpReq?: { _meta?: RequestMeta | unknown; [key: string]: unknown };
  sessionId?: string;
  [key: string]: unknown;
}

/**
 * The request's `_meta` object from EITHER SDK context shape, or null when
 * neither carries an object there.
 *
 * v2's `mcpReq._meta` is consulted first: it is the shape the SDK in service
 * produces, and a flat `_meta` beside it on a v2 ctx could only be a fixture's.
 * The flat field remains the fallback so a v1-shaped caller or hand-built
 * fixture still reads. Never throws.
 */
export function requestMetaOf(extras: RequestExtras | undefined): RequestMeta | null {
  if (!extras) return null;
  const candidates: unknown[] = [extras.mcpReq?._meta, extras._meta];
  for (const meta of candidates) {
    if (meta && typeof meta === "object" && !Array.isArray(meta)) return meta as RequestMeta;
  }
  return null;
}

/**
 * Read and validate a declared agentId from MCP request extras.
 *
 * Returns the parsed agentId if `_meta["io.minsky/agent_id"]` is a
 * non-empty string that passes format validation.
 * Returns null in all other cases (no _meta, wrong type, malformed format).
 */
export function readLayer2(extras: RequestExtras | undefined): ParsedAgentId | null {
  // Either SDK context shape (mt#5160) — may be absent or non-object
  const meta = requestMetaOf(extras);
  if (!meta) return null;

  const declared = meta[AGENT_ID_META_KEY];
  if (typeof declared !== "string" || declared.length === 0) return null;

  // Delegate to format parser — returns null if malformed
  return parseAgentId(declared);
}
