/**
 * Shared canonical `conversationId` param + deprecated-alias resolution for the
 * `transcripts_*` command family (mt#2526 / ADR-022).
 *
 * Before mt#2526 the family was internally INCONSISTENT on the conversation-id
 * param key: `transcripts_get` / `transcripts_similar` used `sessionId`, while
 * `transcripts_search` / `search-text` / `index-embeddings` / `spawns-extract`
 * used `session`. Both keys name the HARNESS CONVERSATION id (the agent-session
 * UUID), NOT a Minsky workspace session. This module unifies the family on the
 * canonical `conversationId` key while keeping the old keys as deprecated,
 * back-compat aliases (non-breaking) — resolved via `resolveConversationId`.
 *
 * The alias window is not permanent debt: deprecation-warning + removal are
 * bundled under the public-rename gate mt#2527 (see the mt#2526 spec).
 *
 * @see mt#2526 — this change
 * @see ADR-022 — the workspace / session / conversation terminology decision
 */

import { z } from "zod";

/**
 * Canonical conversation-id param descriptor. `required` defaults to `false`;
 * commands where the id is mandatory enforce that at execute time via
 * `resolveConversationId` (so the deprecated alias still satisfies the requirement).
 */
export function conversationIdParam(description: string, required = false) {
  return { schema: z.string(), description, required };
}

/**
 * Deprecated-alias param descriptor for the pre-mt#2526 key (`sessionId` or
 * `session`). Kept so existing callers keep working; always optional.
 */
export function deprecatedConversationAlias(oldKey: "sessionId" | "session") {
  return {
    schema: z.string(),
    description: `DEPRECATED alias for conversationId (mt#2526 / ADR-022) — pass conversationId instead of ${oldKey}.`,
    required: false,
  };
}

/**
 * Resolve the conversation id from a params bag, honoring the deprecated
 * `sessionId` / `session` aliases. Returns `undefined` when none is present
 * (callers that require it throw their own clear error).
 */
export function resolveConversationId(params: Record<string, unknown>): string | undefined {
  const raw = params.conversationId ?? params.sessionId ?? params.session;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
