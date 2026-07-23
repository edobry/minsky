/**
 * The explicit, logged stand-in for call sites that hold a Minsky WORKSPACE
 * session id where a harness CONVERSATION id is required.
 *
 * `agent_transcripts.agent_session_id` is the harness conversation keyspace.
 * Three call sites read a workspace session id out of Minsky's own tables and
 * hand it to `AgentTranscriptService.getTranscript`, which used to accept a
 * plain `string` and cast it internally (`sessionId as AgentSessionId`). The
 * lookup never matches — and because a miss returns `null`, every one of those
 * call sites degraded into the same value a legitimately-empty result produces.
 * Measured 2026-07-23: 0 of 1,303 `provenance.session_id` values appear in
 * `agent_transcripts.agent_session_id`.
 *
 * mt#3066 typed the seam `ConversationId`, which turned those call sites into
 * compile errors. Resolving them needs a schema decision that belongs to
 * mt#3101, so they route through this function in the meantime. It does NOT
 * resolve anything: it re-labels the id and logs, once per call site per
 * process, that the lookup is expected to miss. That is the whole point — the
 * failure is now named and greppable instead of an invisible inline cast.
 *
 * Do NOT add call sites. A new caller with a real conversation id should pass
 * it directly; a new caller without one needs mt#3101's resolution first.
 *
 * TEMPORARY MECHANISM BUDGET (`work-completion.mdc §Temporary mechanism budget`).
 * Retirement task: **mt#3101** — it resolves the provenance id space and deletes
 * both call sites, at which point this module goes with them. Escalation
 * threshold: **a third call site, or mt#3101 still open 5 days after this
 * lands**. Either means the stopgap has become load-bearing and needs a real
 * fix rather than another adopter. The warning below prints the calling frame
 * precisely so an unexpected third adopter identifies itself in the logs
 * instead of hiding behind the two known ones (PR #2227 review, non-blocking).
 *
 * @internal Not exported from `./index.ts` — importing it outside the two
 *   audited call sites defeats the typed seam it exists to work around.
 *
 * @see mt#3066 — typed the seam and enumerated the call sites
 * @see mt#3101 — owns the id-space fix for the provenance/authorship callers
 * @see ADR-022 / mt#2524 — the workspace-vs-conversation id-space split
 */

import { log } from "@minsky/shared/logger";
import type { ConversationId, WorkspaceId } from "../ids";
import type { AgentTranscriptService } from "../provenance/transcript-service";

/** Call sites already warned about in this process (one log line each). */
const warnedCallSites = new Set<string>();

/** The warn sink; injectable so tests need no global logger mock. */
export type WarnSink = (message: string) => void;

/**
 * Re-label a workspace session id as a conversation id for a lookup that is
 * known not to resolve, logging the mismatch once per call site per process.
 *
 * @param workspaceSessionId the Minsky workspace session id the caller holds
 * @param callSite a stable identifier for the caller, used to dedupe the log
 *   (e.g. `"session-merge-operations:authorship-judging"`)
 * @param warn the warn sink; defaults to the domain logger
 */
export function unresolvedWorkspaceIdAsConversationId(
  workspaceSessionId: string,
  callSite: string,
  warn: WarnSink = (message) => log.warn(message)
): ConversationId {
  if (!warnedCallSites.has(callSite)) {
    warnedCallSites.add(callSite);
    warn(
      `${callSite}: looking up a transcript by Minsky workspace session id against the ` +
        "conversation keyspace — this lookup is expected to return null until mt#3101 " +
        "resolves the id space. Any 'no transcript' result from this call site is this " +
        `defect, not an empty transcript. Called from: ${callerFrame()}`
    );
  }
  return workspaceSessionId as ConversationId;
}

/**
 * The caller's stack frame, for traceability when a call site appears that is
 * not one of the two audited ones. Best-effort: returns "unknown" rather than
 * throwing if the runtime gives no usable stack.
 */
function callerFrame(): string {
  const frames = new Error().stack?.split("\n") ?? [];
  // [0] "Error", [1] callerFrame, [2] unresolvedWorkspaceIdAsConversationId, [3] the caller.
  return frames[3]?.trim() ?? "unknown";
}

/** Reset the per-process log dedupe. Exported for tests. */
export function resetUnresolvedConversationIdWarnings(): void {
  warnedCallSites.clear();
}

// ── Compile-time contract lock (mt#3066) ─────────────────────────────────────
//
// The durable fix for this bug class is that `getTranscript`'s parameter is a
// branded `ConversationId`, so a workspace id cannot be passed without a
// compile error. That guarantee needs a check that actually runs.
//
// It lives HERE, in a source module, and NOT in a `*.test.ts` file, because
// `packages/**/*.test.ts` is in no typecheck program: the root `tsconfig.json`
// `include` is `["src", "types", "tests", ...]`, and files under `packages/`
// enter the program only by being imported from `src/`. Nothing imports a test
// file, so a `@ts-expect-error` written in one is never evaluated — it would be
// exactly the inert-verification shape this whole task exists to fix. This
// module IS imported by `provenance-service.ts`, which `src/` reaches, so the
// assertions below are checked on every `validate_typecheck` run. Verified by
// negative control: widening the parameter back to `string` fails the build.
//
// mt#3102 owns closing that coverage gap; once it lands, this lock can move to
// the sibling test file where it more naturally belongs.
//
// The runtime behavior of this module is covered in the co-located
// `unresolved-conversation-id.test.ts`.

type FirstParameter<T> = T extends (first: infer P, ...rest: never[]) => unknown ? P : never;

type TranscriptLookupKey = FirstParameter<AgentTranscriptService["getTranscript"]>;

type AssertTrue<T extends true> = T;

/** A `WorkspaceId` must NOT satisfy the transcript lookup key. */
type _WorkspaceIdIsRejected = AssertTrue<WorkspaceId extends TranscriptLookupKey ? false : true>;

/** A plain `string` must NOT satisfy it either (the pre-mt#3066 signature). */
type _PlainStringIsRejected = AssertTrue<string extends TranscriptLookupKey ? false : true>;

/** A `ConversationId` must satisfy it. */
type _ConversationIdIsAccepted = AssertTrue<
  ConversationId extends TranscriptLookupKey ? true : false
>;
