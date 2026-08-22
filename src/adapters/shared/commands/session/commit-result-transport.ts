/**
 * Transport-shaping for `session.commit`'s result (mt#4417).
 *
 * An MCP result is not read only by the caller that asked for it. When the
 * harness backgrounds a slow call — which `session_commit` routinely is, since
 * its pre-commit hook runs the gated suite — it pastes the entire result into a
 * `<task-notification>` turn on completion. That turn lands in the operator's
 * conversation view AND in the agent's context, in full, whether or not anyone
 * reads a single field of it.
 *
 * Two fields dominate that payload and neither earns its place on the wire:
 *
 *   - **`message`** is, on the ordinary path, the exact string the CALLER just
 *     supplied: `sessionCommit` returns `params.message` verbatim
 *     (`session-commands.ts:588`, `:791`). Echoing it back is a round trip of
 *     the caller's own input. For this repo's multi-paragraph commit style that
 *     is the bulk of the payload — roughly 2,000 of an observed 3,127 characters
 *     (the notification behind mt#4417's report).
 *   - **`files`** is the complete changed-file list, where `filesChanged`
 *     already carries the count. Ordinary commits here are single-digit, but a
 *     `compile` regeneration or a codemod is not, and nothing bounds it.
 *
 * **Why this keys on the transport rather than trimming unconditionally.** The
 * CLI genuinely renders both fields: `result-formatter.ts:381` falls back to
 * `message` when `subject` is missing, and `:405-406` prints every `files`
 * entry. Trimming for everyone would regress `minsky session commit`'s output to
 * fix a problem the CLI does not have. `context.interface` is the existing
 * discriminator for exactly this kind of split — `commands/security.ts` already
 * gates a process exit on `interface === "cli"`.
 *
 * @see src/adapters/shared/commands/session/workflow-commands.ts — the caller
 * @see src/adapters/shared/bridges/cli/result-formatter.ts — the CLI consumer this protects
 */

/**
 * Files returned over the wire before the list is capped.
 *
 * Grounded in observed commit sizes rather than a round number
 * (`decision-defaults.mdc §Thresholds`): commits sampled from this repo while
 * specifying mt#4417 carried 6, 9 and 9 changed files, so ordinary work sits an
 * order of magnitude below this cap and is returned whole. The cap exists for
 * the class that is genuinely unbounded — a `compile` run regenerating every
 * rule output, or a codemod sweep — where the list is both enormous and the
 * least likely to be read entry-by-entry.
 */
export const MAX_WIRE_FILES = 50;

/** What replaced a dropped `message`, so a reader is never left guessing. */
export type MessageOmissionReason = "echoed-caller-input";

export interface FilesTruncation {
  returned: number;
  total: number;
}

/**
 * Shape a `session.commit` result for the transport carrying it.
 *
 * Returns `result` untouched for every transport but MCP — the CLI, and any
 * caller that supplies no interface at all (tests, direct domain use), keep
 * today's payload exactly.
 *
 * **`message` is dropped ONLY when it is byte-identical to what the caller
 * passed.** That condition is doing real work: every path that puts something
 * ELSE in the field is load-bearing, and each survives untouched.
 *
 *   - `"Nothing to commit, working tree clean"` — the caller never sent this,
 *     and it is the whole outcome of the call.
 *   - The mt#3660 stash-restore warning, which reports that work parked by an
 *     earlier `session_update` is NOT in this commit. Dropping that would
 *     reintroduce the exact defect mt#3660 shipped to fix — a commit whose
 *     message describes work still sitting in a stash.
 *   - `--amend` with no message, where git reuses the previous commit's body.
 *     The caller has never seen that text, so it is new information.
 *
 * Comparing against the caller's own input is what makes those safe without
 * enumerating them: anything the caller did not write is, by construction, worth
 * returning. A length cap would have had to guess at each one instead.
 */
export function shapeCommitResultForTransport<T extends Record<string, unknown>>(
  result: T,
  suppliedMessage: unknown,
  transport: string | undefined
): Record<string, unknown> {
  if (transport !== "mcp") return result;

  const shaped: Record<string, unknown> = { ...result };

  if (typeof suppliedMessage === "string" && shaped.message === suppliedMessage) {
    delete shaped.message;
    shaped.messageOmitted = "echoed-caller-input" satisfies MessageOmissionReason;
  }

  const files = shaped.files;
  if (Array.isArray(files) && files.length > MAX_WIRE_FILES) {
    shaped.files = files.slice(0, MAX_WIRE_FILES);
    shaped.filesTruncated = {
      returned: MAX_WIRE_FILES,
      total: files.length,
    } satisfies FilesTruncation;
  }

  return shaped;
}
