/**
 * What a conversation-route id actually addresses (mt#3132 Scope item 5).
 *
 * The unified conversation route accepts BOTH id spaces: a harness conversation
 * uuid, and the spawn-time local id an actuator is addressed by. This module is
 * the pure resolution between them.
 *
 * ## Why resolution cannot be done by id SHAPE
 *
 * The natural-looking implementation — "uuid-shaped means conversation,
 * anything else means actuator" — is wrong, and mt#3132's
 * `## Implementation-entry findings` records why. A driven record's `localId`
 * is minted as `opts.localId ?? randomUUID()` (`src/cockpit/driven-session-host.ts`),
 * so the DEFAULT local id is uuid-shaped and passes `looksLikeConversationId`
 * cleanly. It does not fail as a wrong-id-space error; it fails LATER, as a
 * genuine 404, because no such conversation exists in the transcripts DB yet.
 * Meanwhile an entity-thread spawn mints a local id that is NOT uuid-shaped and
 * fails the shape check outright. Both failure modes are real, and neither is
 * distinguishable from the id alone.
 *
 * So resolution is a REGISTRY LOOKUP, mirroring `DrivenSessionRegistry.get()`'s
 * own `byLocalId.get(id) ?? byHarnessId.get(id)` dual-space precedence.
 *
 * ## Why an actuator with no conversation is a first-class state
 *
 * `linkHarnessId` only runs on the harness `init` frame, while the cockpit
 * navigates on the spawn POST's success — strictly earlier. In that window the
 * record has no `harnessSessionId` AT ALL, so there is nothing to translate the
 * local id INTO: no amount of id mapping can serve the transcript, because the
 * conversation does not exist yet. The route has to be able to say "known
 * actuator, no conversation yet" rather than 404.
 *
 * @see mt#3132 — `## The id-space question` and `## Implementation-entry findings`
 * @see src/cockpit/driven-session-host.ts — `registry.get()`, `linkHarnessId`
 */

/**
 * One row of `GET /api/driven-session`'s registry snapshot — the subset this
 * resolution needs. Declared structurally rather than imported from the host
 * module: the cockpit bundle's contract is with the endpoint's JSON wire shape,
 * and `driven-session-host.ts` is server-side code this bundle must not pull in.
 */
export interface ActuatorSummary {
  /** The spawn-time local id — what `/driven/:id` is addressed by. */
  sessionId: string;
  /** The harness conversation id, once the `init` frame has linked it. */
  harnessSessionId: string | null;
  /** Registry lifecycle: `spawned` / `running` / `exited` / `crashed` / … */
  status: string;
}

/**
 * What the route's `:id` resolved to.
 *
 * `actuator` is carried on the `conversation` variant too — a conversation that
 * HAS a live actuator is still just a conversation for read purposes (that is
 * this task's whole thesis), but the route needs to know one exists so it can
 * offer the drive view.
 */
export type ConversationAddress =
  | { kind: "conversation"; conversationId: string; actuator: ActuatorSummary | null }
  | { kind: "actuator-starting"; localId: string; actuator: ActuatorSummary };

/**
 * Resolve a route id against the actuator registry snapshot.
 *
 * Precedence matches `DrivenSessionRegistry.get()`: local id first, harness id
 * second. An id matching NEITHER resolves to a plain conversation — the
 * overwhelmingly common case, and the behavior the route had before this task,
 * preserved exactly.
 */
export function resolveConversationAddress(
  id: string,
  actuators: readonly ActuatorSummary[]
): ConversationAddress {
  const byLocalId = actuators.find((a) => a.sessionId === id);
  if (byLocalId) {
    // Linked: the local id is a permanently-valid ALIAS for the conversation.
    // Resolved internally rather than redirected — mt#3132 requires local-id
    // URLs to keep working forever, and a redirect would rewrite an address the
    // operator (or a stored deeplink) deliberately used.
    if (byLocalId.harnessSessionId) {
      return {
        kind: "conversation",
        conversationId: byLocalId.harnessSessionId,
        actuator: byLocalId,
      };
    }
    return { kind: "actuator-starting", localId: id, actuator: byLocalId };
  }

  const byHarnessId = actuators.find((a) => a.harnessSessionId === id);
  return { kind: "conversation", conversationId: id, actuator: byHarnessId ?? null };
}

/**
 * Whether a starting actuator can still be expected to produce a conversation.
 *
 * A record that reached a terminal status without ever linking a harness id
 * never will — the child exited before emitting its `init` frame. Rendering
 * "starting…" forever in that case would be the falsely-confident state this
 * whole umbrella exists to remove.
 */
export function actuatorMayStillLink(actuator: ActuatorSummary): boolean {
  return actuator.status !== "exited" && actuator.status !== "crashed";
}
