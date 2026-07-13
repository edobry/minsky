/**
 * Branded (nominal) ID types for Minsky.
 *
 * Prevents passing the wrong kind of ID at compile time — e.g., a
 * ConversationId (harness agentSessionId) where a WorkspaceId
 * (Minsky workspace sessionId) is expected, or vice versa.
 *
 * Zero runtime cost: brands erase to plain strings on the wire and are
 * re-minted on the next inbound parse (zod boundary or explicit cast).
 *
 * Pattern: string-tag intersection — the community-standard zero-runtime
 * approach. NOT zod .brand() to keep ONE canonical type that matches both
 * the zod schemas and the drizzle .$type<>() annotations.
 *
 * GOTCHAS:
 * - Do NOT pass branded columns to drizzle-zod createSelectSchema /
 *   createInsertSchema (bug drizzle-orm#3834 — hand-write those schemas).
 * - Avoid zod v4 .pipe() after a brand (#5648).
 * - Use Map<BrandedId, V> not Record<BrandedId, V> for keyed maps
 *   (Record key type is not enforced).
 *
 * @see mt#2524 — this file
 * @see mt#2420 — the id-space confusion bug this prevents
 */

// ── Brand helper ─────────────────────────────────────────────────────────────

declare const __brand: unique symbol;

/**
 * Make T a branded (nominal) type tagged with Tag.
 *
 * Usage:
 *   export type WorkspaceId = Brand<string, "WorkspaceId">;
 *   const id = "abc-123" as WorkspaceId;
 */
export type Brand<T, Tag extends string> = T & { readonly [__brand]: Tag };

// ── ID kinds ──────────────────────────────────────────────────────────────────

/**
 * Minsky workspace session ID — the primary key of the `sessions` table
 * (SessionRecord.sessionId). Identifies a task-scoped workspace, NOT a
 * harness conversation.
 *
 * Source: the Minsky internal UUID generated at `session_start`.
 * Wire format: plain string; re-mint on inbound parse.
 */
export type WorkspaceId = Brand<string, "WorkspaceId">;

/**
 * Harness agent session ID — the primary key of the `agent_transcripts` table
 * (agentSessionId). Identifies a Claude Code (or other harness) conversation,
 * NOT a Minsky workspace.
 *
 * Source: the harness-native UUID from the JSONL transcript file name.
 * Wire format: plain string; re-mint on inbound parse.
 */
export type ConversationId = Brand<string, "ConversationId">;

/**
 * MCP server session token — the opaque token carried in the
 * `mcp-session-id` header by the stateful HTTP MCP transport.
 * Distinct from both WorkspaceId and ConversationId.
 */
export type McpSessionId = Brand<string, "McpSessionId">;
