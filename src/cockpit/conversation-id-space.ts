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
 * A harness conversation id (`ConversationId`/`AgentSessionId`) is, by this
 * system's own data model, "the harness-native UUID from the JSONL
 * transcript file name" (see `transcript-source.ts`'s `DiscoveredSession`
 * doc comment) — so a value that isn't UUID-shaped can never resolve to a
 * transcript no matter how long a caller waits on it. mt#3131 (D3/D5):
 * reject these BEFORE any DB query or provider probe, both endpoints named
 * in scope (`/api/conversation/:id/overview`,
 * `/api/cockpit/context-inspector/snapshot`) — this is a zero-I/O regex
 * test, so it can never hang, and it lets the caller distinguish "this could
 * never have been a conversation id" (D5: "Not found") from "syntactically
 * plausible, just not ingested (yet)" (D5: "Not yet ingested" / "may still
 * be running").
 *
 * Verified against the two mt#3131 repro ids: `agent-a2a1e886c52ade5b9`
 * (wrong prefix, wrong hyphen positions) and `958f3805` (8 hex chars, no
 * hyphens at all) — both fail this check, regardless of which OTHER id space
 * either one might belong to (e.g. a subagent dispatch-tracking id).
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function looksLikeConversationId(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * Race `promise` against a timeout so a hanging downstream dependency (a
 * provider probe, a DB query under contention) can never leave an HTTP
 * response pending indefinitely (mt#3131 D3). Rejects with an `Error` named
 * `"TimeoutError"` on expiry — callers distinguish this from a genuine probe
 * failure only if they need to; both are treated as "couldn't confirm" by
 * the fail-open callers in this file.
 */
export async function withBoundedTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Timed out after ${timeoutMs}ms`);
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Default bound for the workspace-id probe inside {@link classifySnapshotMiss}. */
export const SNAPSHOT_MISS_PROBE_TIMEOUT_MS = 5_000;

/**
 * Decide why a snapshot lookup missed.
 *
 * `isKnownWorkspaceId` is injected (the server passes a
 * `getServerSessionProvider().getSession`-backed probe) so this stays a pure,
 * unit-testable decision with no DB coupling. `probeTimeoutMs` defaults to
 * {@link SNAPSHOT_MISS_PROBE_TIMEOUT_MS}; tests override it with a short bound
 * to exercise the timeout path without a slow real-time wait.
 *
 * Fail-open posture: a probe that throws OR times out (provider unavailable,
 * DB error, hung network call) must never upgrade a benign not-found into a
 * 500 — it falls back to `"not_found"` (mt#3131 D3: this is what turns a
 * potential indefinite hang into a bounded response).
 */
export async function classifySnapshotMiss(
  requestedId: string,
  isKnownWorkspaceId: (id: string) => Promise<boolean>,
  probeTimeoutMs: number = SNAPSHOT_MISS_PROBE_TIMEOUT_MS
): Promise<SnapshotMissClass> {
  try {
    // mt#3131 (D3): `isKnownWorkspaceId` is provider-backed (a live
    // `getServerSessionProvider().getSession()` call) and can itself be a
    // network round-trip with no caller-side timeout — bound it so a slow or
    // hung provider can't leave this classification (and the HTTP response
    // it gates) pending indefinitely.
    if (await withBoundedTimeout(isKnownWorkspaceId(requestedId), probeTimeoutMs)) {
      return "wrong_id_space";
    }
  } catch {
    // Defensive: a failed OR timed-out workspace probe must not crash the
    // request — fall back to the "not_found" classification below.
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
