/**
 * Which conversation a presence claim was written from (mt#3945).
 *
 * Split out of `server.ts` so the decision is a pure function of its inputs:
 * the only impure part — reading the ambient env var — happens at the call
 * site, and this module can be exercised without constructing a server or
 * mutating `process.env`.
 *
 * @see docs/architecture/adr-006-agent-identity.md — `actorId` is the
 *   conversation-grain identity key this derives from.
 */
import { conversationIdFromAgentId } from "@minsky/domain/agent-identity/format";

/**
 * Resolve the `cc_conversation_id` for a presence claim.
 *
 * Derived from `actorId` whenever that names a conversation, so the column
 * cannot disagree with `actor_id` — for a conversation-scoped actor the value
 * IS the `conv:` segment. Before mt#3945 both presence writers read an env var
 * instead; see the `resolveCcConversationId` doc comment in `server.ts` for the
 * full history and why the env read is now a floor rather than a source.
 *
 * @param actorId  The caller's resolved agentId (ADR-006 layers 1-3).
 * @param ambientConversationId  The spawn-time env value, used ONLY when
 *   `actorId` names no conversation (a Layer-1 `unknown:hash:` ascription).
 *   Stale by construction on a long-lived server process — a last resort, not
 *   a second opinion.
 * @returns The conversation id, or undefined when neither source has one.
 */
export function resolvePresenceConversationId(
  actorId: string,
  ambientConversationId?: string | undefined
): string | undefined {
  const fromActor = conversationIdFromAgentId(actorId);
  if (fromActor) return fromActor;

  return typeof ambientConversationId === "string" && ambientConversationId.length > 0
    ? ambientConversationId
    : undefined;
}
