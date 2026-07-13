/**
 * Conversation id-space fail-loud classification (mt#2525 / mt#2420).
 *
 * The cockpit snapshot endpoint
 * `GET /api/cockpit/context-inspector/snapshot?sessionId=` expects a HARNESS
 * conversation id (`agentSessionId`, a `ConversationId`). The cockpit's
 * `/agents` rows carry a Minsky WORKSPACE session id (`WorkspaceId`); piping
 * one into `/session/:id` produced a 404 that `ConversationView` rendered as a
 * misleading "No conversation transcript yet" empty state (mt#2420).
 *
 * mt#2524 closed the COMPILE-time half (branded `WorkspaceId` vs
 * `ConversationId` in `packages/domain/src/ids.ts`). This is the RUNTIME
 * complement: when no transcript is found, decide whether the requested id is
 * actually a known workspace id (a misrouted-id-space mistake) so the endpoint
 * can FAIL LOUD with a distinct, correct error instead of the generic
 * "not found".
 *
 * @see mt#2525 — this file (Tier-0 fail-loud id-space hardening)
 * @see mt#2420 — the id-space confusion bug
 * @see mt#2524 — the compile-time branded-id guard this complements
 */

/**
 * Classification of a snapshot "miss" (no `agent_transcripts` row for the
 * requested id):
 *   - `"wrong_id_space"` — the id is a known Minsky WORKSPACE session id, so a
 *     harness conversation id was expected but a workspace id was supplied.
 *   - `"not_found"` — the id is unknown to the workspace substrate too; a
 *     genuine "no transcript (yet)" for an otherwise-plausible conversation id.
 */
export type SnapshotMissClass = "wrong_id_space" | "not_found";

/**
 * Decide why a snapshot lookup missed.
 *
 * `isKnownWorkspaceId` is injected (the server passes a
 * `getServerSessionProvider().getSession`-backed probe) so this stays a pure,
 * unit-testable decision with no DB coupling.
 *
 * Fail-open posture: a probe that throws (provider unavailable, DB error) must
 * never upgrade a benign not-found into a 500 — it falls back to `"not_found"`.
 */
export async function classifySnapshotMiss(
  requestedId: string,
  isKnownWorkspaceId: (id: string) => Promise<boolean>
): Promise<SnapshotMissClass> {
  try {
    if (await isKnownWorkspaceId(requestedId)) return "wrong_id_space";
  } catch {
    // Defensive: a failed workspace probe must not crash the request.
  }
  return "not_found";
}

/**
 * User-safe message for the wrong-id-space case. Phrased DESCRIPTIVELY (not
 * with a single proposed noun) because the authoritative session/workspace
 * rename is principal-reserved and not yet locked (mt#2527 / mt#2513).
 */
export const WRONG_ID_SPACE_MESSAGE =
  "That id is a Minsky workspace session id, not a harness conversation id. " +
  'Open the workspace\'s session detail page and use its "View conversation" link ' +
  "to reach the transcript.";
