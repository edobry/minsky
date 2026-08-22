// Pure functions for the raw-`Agent`-spawn dispatch correlation stamp (mt#2292).
//
// The problem these solve, stated precisely: the harness gives the DISPATCH side
// and the CLOSE side two different identifiers, and nothing in either payload
// joins them.
//
//   - PreToolUse on `Agent` carries `session_id` + `tool_use_id`, and no
//     `agent_id` (the subagent does not exist yet).
//   - SubagentStop carries `agent_id` + `agent_transcript_path`, and no
//     `tool_use_id`.
//
// So the parent writes its own key INTO the dispatched prompt via
// `updatedInput`, and the close side reads it back out of the child's own
// transcript — the one file `agent_transcript_path` hands it. The prompt is the
// only channel that provably crosses the boundary: measured 2026-08-08, a
// dispatched prompt lands verbatim as the first `user` record of
// `<session-dir>/subagents/agent-<agentId>.jsonl`.
//
// Kept separate from the guard's imperative shell so the format, its parser, and
// the recording decision are testable without a DB, a harness payload, or a
// domain bootstrap — the coupling that let the pre-mt#3019 Stop-side bug hide
// behind green mocks.

/**
 * Stamp version marker. Bump ONLY on a breaking format change, and keep the old
 * pattern parseable for as long as un-ingested child transcripts may still carry
 * it — a Stop event can arrive for a subagent dispatched by a prior build.
 */
// Re-exported, not re-declared (PR #3242 R2): the token is shared vocabulary
// with `user-line-origin.ts`, which reads back what this module writes. One
// definition, so the two cannot drift apart.
export { DISPATCH_STAMP_VERSION } from "@minsky/domain/transcripts/user-line-origin";
import { DISPATCH_STAMP_VERSION } from "@minsky/domain/transcripts/user-line-origin";

/**
 * Matches a stamp anywhere in a body of text.
 *
 * Deliberately tolerant of surrounding whitespace and of trailing content on the
 * line, because the text this runs against is a JSONL record's decoded `content`
 * field, not a line the writer controls end to end.
 */
const STAMP_PATTERN = new RegExp(
  `<!--\\s*${DISPATCH_STAMP_VERSION}\\s+parent=(\\S+)\\s+tool_use=(\\S+)\\s*-->`
);

/** The dispatch-side identity a stamp carries. */
export interface DispatchStamp {
  /** Harness conversation id of the dispatching (parent) agent. */
  parentAgentSessionId: string;
  /** Harness `tool_use` id of the `Agent` call. */
  parentToolUseId: string;
}

/**
 * Render a stamp for one `Agent` dispatch.
 *
 * An HTML comment, because the prompt is consumed by a model: the marker reads
 * as metadata rather than as an instruction, and no subagent has to be told to
 * ignore it.
 */
export function buildDispatchStamp(stamp: DispatchStamp): string {
  return `<!-- ${DISPATCH_STAMP_VERSION} parent=${stamp.parentAgentSessionId} tool_use=${stamp.parentToolUseId} -->`;
}

/**
 * Recover a stamp from arbitrary text (a prompt, or a child transcript record).
 * Returns null when no stamp is present — the normal case for a subagent
 * dispatched before this shipped, and for any prompt the guard did not rewrite.
 */
export function parseDispatchStamp(text: string | undefined | null): DispatchStamp | null {
  if (!text) return null;
  const match = STAMP_PATTERN.exec(text);
  if (!match?.[1] || !match[2]) return null;
  return { parentAgentSessionId: match[1], parentToolUseId: match[2] };
}

/**
 * Append a stamp to a dispatched prompt.
 *
 * Appended rather than prepended so the subagent's first-read instruction stays
 * the first thing in its prompt. Idempotent: a prompt that already carries a
 * stamp is returned unchanged, so a re-dispatch of an already-stamped prompt
 * cannot accumulate markers or overwrite the original dispatch's identity.
 */
export function stampPrompt(prompt: string, stamp: DispatchStamp): string {
  if (parseDispatchStamp(prompt)) return prompt;
  return `${prompt}\n\n${buildDispatchStamp(stamp)}`;
}

/**
 * Recover the dispatch stamp from a child transcript's raw JSONL lines.
 *
 * Takes lines rather than a path so the scan is pure — the Stop hook owns the
 * file read. Scans in order and returns the FIRST stamp found, because the
 * dispatched prompt is the child's first `user` record: measured 2026-08-08, a
 * probe token appeared in exactly that record (and again in an assistant line
 * that quoted it back, which is why first-wins rather than last-wins matters).
 *
 * Deliberately a substring scan over the raw line rather than a parse of the
 * decoded `content` field. The stamp is plain ASCII with no JSON metacharacters,
 * so it survives JSON encoding byte-for-byte, and a raw scan cannot be defeated
 * by the several record shapes a `content` field takes (a bare string, or an
 * array of typed blocks). Malformed JSON lines are skipped for free rather than
 * throwing.
 *
 * Returns null when no line carries a stamp — a subagent dispatched before this
 * shipped, or one whose dispatch-time rewrite did not land.
 */
export function findStampInTranscriptLines(lines: readonly string[]): DispatchStamp | null {
  for (const line of lines) {
    const stamp = parseDispatchStamp(line);
    if (stamp) return stamp;
  }
  return null;
}

/**
 * Extract the Minsky workspace session id a generated prompt refers to.
 *
 * `session_generate_prompt` emits absolute session-workspace paths
 * (`~/.local/state/minsky/sessions/<sessionId>/...`) and forbids `cd`, which is
 * what makes the id recoverable from the prompt text at all. Returns null for a
 * prompt that names no session — a bare `Explore`/`general-purpose` dispatch,
 * which legitimately has no Minsky workspace.
 *
 * This is the reconciliation key for the no-double-write rule: a prompt that
 * names a session already has a row, written by `session_generate_prompt`.
 */
export function extractMinskySessionIdFromPrompt(prompt: string | undefined): string | null {
  if (!prompt) return null;
  const match = prompt.match(/\/sessions\/([0-9a-fA-F-]{8,})(?:[/\s"'`]|$)/);
  return match?.[1] ?? null;
}

/**
 * Sentinel written to `agent_type` when the payload carries no `subagent_type`.
 *
 * Duplicated from `src/mcp/subagent-dispatch-tracker.ts`'s `UNKNOWN_AGENT_TYPE`
 * rather than imported, for the same reason `HOOK_UNKNOWN_TASK_ID` is duplicated
 * in `record-subagent-invocation.ts`: it keeps this module pure, synchronous and
 * dependency-free, so its tests need no domain module tree. The sibling test
 * pins the two constants equal, so a change to either side fails a test rather
 * than drifting silently.
 */
export const HOOK_UNKNOWN_AGENT_TYPE = "unknown";

/** What the dispatch-time guard should do with one `Agent` tool call. */
export type DispatchRecordingDecision =
  | { action: "skip"; reason: string }
  | {
      action: "record";
      stamp: DispatchStamp;
      /** Present when the prompt names a Minsky workspace — see {@link extractMinskySessionIdFromPrompt}. */
      subagentSessionId: string | null;
      agentType: string;
    };

/**
 * Decide whether an `Agent` call can be recorded, from the PreToolUse payload
 * alone.
 *
 * The only skip case is a missing harness identifier. Both are supplied by the
 * harness on every real `Agent` call (observed 2026-08-05), so a skip here means
 * a synthetic or malformed payload — recording one would produce a row keyed on
 * nothing, which is strictly worse than recording nothing at all. That is the
 * same judgment `decideRecordingAction` makes on the Stop side, for the same
 * reason.
 *
 * Note what is NOT a skip: an unresolvable task id. The row is still worth
 * writing — it carries a real dispatch that really happened — and the task id
 * sentinel exists precisely so the Stop side can fill in what the dispatch side
 * could not.
 */
export function decideDispatchRecording(params: {
  sessionId: string | undefined;
  toolUseId: string | undefined;
  prompt: string | undefined;
  subagentType: string | undefined;
}): DispatchRecordingDecision {
  const { sessionId, toolUseId, prompt, subagentType } = params;

  if (!sessionId || !toolUseId) {
    return {
      action: "skip",
      reason: `missing harness identity (session_id=${sessionId ?? "absent"}, tool_use_id=${toolUseId ?? "absent"})`,
    };
  }

  return {
    action: "record",
    stamp: { parentAgentSessionId: sessionId, parentToolUseId: toolUseId },
    subagentSessionId: extractMinskySessionIdFromPrompt(prompt),
    agentType: subagentType && subagentType.length > 0 ? subagentType : HOOK_UNKNOWN_AGENT_TYPE,
  };
}
