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
 * @see mt#3131 — `looksLikeConversationId` + `withBoundedTimeout` (D3/D5),
 *   originally UUID-only
 * @see mt#3109 — inline agent-spawns ingest that widened the real id space
 *   `looksLikeConversationId` must accept (see the doc comment above
 *   {@link UUID_RE} for the full premise-change trail)
 * @see mt#3225 — reconciled `looksLikeConversationId` with the post-mt#3109
 *   id space (this predicate's second shape, `AGENT_PREFIXED_RE`)
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
 * Premise history (mt#3225): this predicate's admissible id-shape set has
 * changed once already, and the change is recorded here rather than
 * silently overwriting the superseded reasoning.
 *
 * **mt#3131 (D3/D5), original premise — UUID-only.** At the time mt#3131
 * shipped, a harness conversation id (`ConversationId`/`AgentSessionId`) was,
 * by this system's own data model, "the harness-native UUID from the JSONL
 * transcript file name" (see `transcript-source.ts`'s `DiscoveredSession`
 * doc comment) — so a value that wasn't UUID-shaped could never resolve to a
 * transcript no matter how long a caller waited on it. That reasoning was
 * CORRECT at the time: reject non-UUID ids before any DB query or provider
 * probe (zero-I/O, can never hang), distinguishing "this could never have
 * been a conversation id" (D5: "Not found") from "syntactically plausible,
 * just not ingested (yet)" (D5: "Not yet ingested" / "may still be
 * running"). The repro id cited then, `agent-a2a1e886c52ade5b9`, was a
 * subagent dispatch-tracking id with no corresponding transcript row — at
 * the time, no ingest path ever wrote a transcript keyed by that shape.
 *
 * **mt#3109, merged the SAME DAY, changed the data model underneath this
 * premise.** `AgentTranscriptIngestService` wired `AgentSpawnsPipeline` (and,
 * more directly, `ClaudeCodeTranscriptSource.discoverSessions()`'s existing
 * `<projectDir>/<sessionId>/subagents/*.jsonl` scan) into the normal ingest
 * path, so subagent transcripts are now routinely ingested as their own
 * `agent_transcripts` rows — keyed by the JSONL basename Claude Code itself
 * assigns those files, which is NOT UUID-shaped. Verified against the real
 * writer (not the observed DB corpus alone, per mt#3225): Claude Code's own
 * subagent-transcript file-naming convention (`agent-${agentId}.jsonl`,
 * where `agentId` is a fixed `"a"` tag followed by 16 lowercase hex
 * characters from an 8-byte random value) produces ids of the exact shape
 * `agent-` + 17 lowercase hex characters — confirmed against 748 real
 * on-disk subagent transcript files (100% consistent) and against both ids
 * this file has ever cited: `agent-a2a1e886c52ade5b9` and
 * `agent-ae944bce40bdc1dd6` are each exactly 17 hex characters after the
 * `agent-` prefix. Neither mt#3131 nor mt#3109 was wrong; the invariant they
 * disagreed on — "what id shapes can hold a transcript" — changed under one
 * of them, and this predicate now matches the CURRENT data model.
 *
 * The D5 miss-class semantics this predicate feeds (`wrong_id_space` /
 * `not_found` in {@link classifySnapshotMiss}) are unchanged: a value that
 * matches NEITHER shape below still gets the zero-I/O reject; a value that
 * matches one of these shapes but has no transcript row still falls through
 * to the DB-backed miss classification below, exactly as before.
 *
 * Verified rejects: `probe-mt3120-diagnostic` (neither shape) and
 * `958f3805` (8 hex chars, no hyphens, too short for either shape) both
 * still fail this check.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Subagent-transcript id shape (mt#3109 / mt#3225): `agent-` followed by
 * exactly 17 lowercase hex characters — the shape Claude Code's own
 * subagent-transcript JSONL file naming produces (`agent-${tag}${hex}.jsonl`,
 * a fixed `"a"` tag + 16 hex characters from an 8-byte random value; see the
 * doc comment above {@link UUID_RE} for the verification trail). The
 * character class is case-insensitive for the same defensive reason
 * {@link UUID_RE} is, even though the real generator only ever emits
 * lowercase.
 */
const AGENT_PREFIXED_RE = /^agent-[0-9a-fA-F]{17}$/;

export function looksLikeConversationId(id: string): boolean {
  return UUID_RE.test(id) || AGENT_PREFIXED_RE.test(id);
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
