/**
 * Pure helpers for the tool-call projection table (mt#3329): tool-name
 * parsing (server/name split) and the `arg_fingerprint` hash.
 *
 * Kept dependency-free (like `conversation-elements.ts` / `turn-extractor.ts`)
 * so both `ToolCallProjectionPipeline` and its tests can exercise this logic
 * without a DB.
 *
 * @see agent-tool-call-projection-schema.ts — destination table
 * @see tool-call-projection-pipeline.ts — consumer
 */

import { createHash } from "crypto";

/** Parsed MCP tool name: `server` is null for a non-MCP (built-in) tool. */
export interface ParsedToolName {
  server: string | null;
  name: string;
}

// Mirrors `event-adapter.ts`'s local `parseToolNameLocal` / the cockpit's
// `tool-name.ts` `parseToolName` convention (server/name split on the
// `mcp__<server>__<name>` prefix). Not imported from either: event-adapter.ts
// already documents why `packages/domain` can't depend on the cockpit
// frontend bundle, and duplicating a 5-line regex here (rather than adding a
// cross-module dependency for it) matches that file's own stated precedent.
const MCP_NAME_RE = /^mcp__(.+?)__(.+)$/;

export function parseToolName(raw: string): ParsedToolName {
  const m = MCP_NAME_RE.exec(raw);
  if (m && m[1] !== undefined && m[2] !== undefined) {
    return { server: m[1], name: m[2] };
  }
  return { server: null, name: raw };
}

/**
 * Absolute Minsky session-workspace path prefix, e.g.
 * `/Users/x/.local/state/minsky/sessions/<uuid>`. Stripped from string leaves
 * before hashing so two logically-identical calls made in different session
 * workspaces (the common case — every task session gets its own directory)
 * fingerprint identically. This is a deliberately cheap, single-regex
 * normalization — it does NOT attempt to normalize file content, diffs, or
 * any other volatile field. Per the task spec: "if not cheap, hash raw
 * input" is the accepted fallback for everything this regex doesn't reach.
 */
const SESSION_WORKSPACE_PATH_RE = /\/[^\s"']*\/sessions\/[0-9a-fA-F-]{36}/g;

/**
 * Recursively normalize a parsed JSON value before hashing: strip
 * session-workspace path prefixes from string leaves, and sort object keys
 * so serialization is deterministic regardless of property insertion order.
 */
function normalizeVolatile(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(SESSION_WORKSPACE_PATH_RE, "<session>");
  }
  if (Array.isArray(value)) {
    return value.map(normalizeVolatile);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = normalizeVolatile(record[key]);
    }
    return out;
  }
  return value;
}

/**
 * Compute a stable, short fingerprint of a tool call's input.
 *
 * NEVER stores the raw input — only this hash is persisted anywhere. The
 * input is normalized (sorted keys, session-workspace paths stripped) before
 * hashing, so two logically-identical calls made in different session
 * workspaces produce the same fingerprint, which is what makes the
 * fingerprint usable as part of a cross-session sequence signature (spec
 * SC 4). 16 hex chars (64 bits) of sha256 — short enough for compact
 * sequence signatures, long enough that collisions are not a practical
 * concern at this corpus's scale (a handful of tool calls per turn across a
 * few thousand conversations).
 */
export function computeArgFingerprint(input: unknown): string {
  const normalized = normalizeVolatile(input ?? null);
  const json = JSON.stringify(normalized);
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}
