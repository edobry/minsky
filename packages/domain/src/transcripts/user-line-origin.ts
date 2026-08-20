/**
 * user-line-origin — who authored the text on a `user`-role transcript line.
 *
 * Claude Code records several kinds of HARNESS-generated content as `type:
 * "user"` lines carrying ordinary text: the summary written at an
 * auto-compaction boundary, an injected skill body, a slash-command expansion,
 * a background-task notification, hook feedback. Every one of them is
 * indistinguishable from operator speech to a consumer that branches on
 * `line.type === "user"` — which, before mt#4289, was every consumer outside
 * the context-inspector lineage.
 *
 * Measured against production 2026-08-19: of the 18,948 `agent_transcript_turns`
 * rows carrying `user_text`, **8,245 (43.5%) are harness-generated**. The
 * compact summary that motivated mt#4289 is 115 of them.
 *
 * ## The predicate reads FIELDS, never text
 *
 * The 43.5% figure was measured with `user_text LIKE` prefixes, because the
 * turns table carried no provenance — that absence is the defect, and the
 * prefixes are not the fix. A prefix match cannot distinguish an operator who
 * pastes `<task-notification>` from the harness emitting one, and it silently
 * stops working when the harness rewords a preamble. Everything below reads the
 * line's own fields, verified by direct observation of the JSONL (mt#4289
 * `## Planning finding`):
 *
 * | kind                       | how the harness marks it                          |
 * | -------------------------- | ------------------------------------------------- |
 * | operator prompt            | `origin: {kind: "human"}`, `promptSource: "typed"` |
 * | compact summary            | `isCompactSummary: true` (and NO `isMeta`)        |
 * | skill body / re-invocation | `isMeta: true`                                    |
 * | task notification          | `origin: {kind: "task-notification"}`             |
 * | peer message               | `origin: {kind: "peer"}`                          |
 * | SDK-driven prompt          | `promptSource: "sdk"`                             |
 *
 * ## Fail-open to operator
 *
 * `origin` and `promptSource` are recent additions; lines predating them carry
 * neither, and the DB corpus reaches further back than the local JSONL window.
 * An unrecognized line is therefore classified {@link OPERATOR_ORIGIN}, not
 * "unknown". The two errors are not symmetric: mis-marking real operator speech
 * as synthetic REMOVES signal from every operator-facing view, while leaving a
 * synthetic line marked operator reproduces exactly today's behavior. Fail
 * toward the status quo.
 *
 * @see mt#4289 — this file
 * @see .minsky/hooks/transcript.ts `isRealUserPrompt` — the hook-layer sibling,
 *   deliberately duplicated rather than imported (separate bundling context,
 *   the same precedent `RETAINED_TYPES` and `SYNTHETIC_INTERRUPT_MARKERS` set)
 */

/**
 * Who authored a turn's `user_text`, as stored in
 * `agent_transcript_turns.user_origin`.
 *
 * Deliberately a `string` rather than a closed union at the storage boundary:
 * `origin.kind` is the HARNESS's vocabulary, not ours, and a kind we have never
 * seen must land as itself rather than be coerced into one of ours. The
 * constants below name the values we produce or depend on; a reader must treat
 * "not one of these" as possible, which is why {@link isOperatorAuthored}
 * compares against the operator value rather than enumerating the rest.
 */
export type UserTextOrigin = string;

/** Genuine operator speech — the only value any consumer should treat as "the human said this". */
export const OPERATOR_ORIGIN: UserTextOrigin = "human";

/** The summary Claude Code writes at an auto-compaction boundary (~15KB of model prose). */
export const COMPACT_SUMMARY_ORIGIN: UserTextOrigin = "compact_summary";

/**
 * A harness-injected user-role line the harness itself marks `isMeta` — skill
 * bodies and slash-command re-invocation notices are the observed members.
 */
export const HARNESS_META_ORIGIN: UserTextOrigin = "harness_meta";

/**
 * Normalize a harness-supplied kind into the column's vocabulary.
 *
 * Only hyphens become underscores (`task-notification` → `task_notification`),
 * so a single convention holds across the harness's values and ours. Nothing
 * else is rewritten: an unrecognized kind survives verbatim, which is what makes
 * a new harness kind visible in a `GROUP BY user_origin` rather than silently
 * folded into an existing bucket.
 */
function normalizeKind(kind: string): UserTextOrigin {
  return kind.trim().replace(/-/g, "_");
}

/** Read a top-level field off an arbitrary harness line, without assuming its shape. */
function readField(line: unknown, key: string): unknown {
  if (!line || typeof line !== "object") return undefined;
  return (line as Record<string, unknown>)[key];
}

/** Read a nested `origin.kind` string, if the line carries one. */
function readOriginKind(line: unknown): string | undefined {
  const origin = readField(line, "origin");
  if (!origin || typeof origin !== "object") return undefined;
  const kind = (origin as { kind?: unknown }).kind;
  return typeof kind === "string" && kind.trim().length > 0 ? kind : undefined;
}

/** Read the top-level `promptSource` string, if the line carries one. */
function readPromptSource(line: unknown): string | undefined {
  const source = readField(line, "promptSource");
  return typeof source === "string" && source.trim().length > 0 ? source : undefined;
}

/**
 * `promptSource` values that describe HOW an operator's own prompt reached the
 * harness rather than who wrote it. `typed` is the interactive case; `queued` is
 * the operator's message held while a turn was in flight — both are the human.
 * Any other value (currently `system`, `sdk`) describes a non-operator writer.
 */
const OPERATOR_PROMPT_SOURCES: ReadonlySet<string> = new Set(["typed", "queued"]);

/**
 * Classify a `user`-role transcript line by who authored its text.
 *
 * Precedence matters and is not arbitrary — the checks are ordered most-specific
 * first, because the markers overlap:
 *
 * 1. `isCompactSummary` FIRST. The compact-summary record carries no `isMeta`
 *    (verified: its key set is `cwd, entrypoint, gitBranch, isCompactSummary,
 *    isSidechain, isVisibleInTranscriptOnly, message, parentUuid, promptId,
 *    sessionId, session_id, slug, timestamp, type, userType, uuid, version`),
 *    so no later check would catch it — this is the one kind with a dedicated
 *    flag and it is checked where it cannot be shadowed.
 * 2. `isMeta` next: the harness's own "this is not the human" bit.
 * 3. `origin.kind`, which names the writer directly. A kind of `human` is
 *    conclusive and returns operator EVEN IF `promptSource` says otherwise —
 *    the writer is a stronger statement than the delivery channel.
 * 4. `promptSource` last, as a fallback for lines carrying no `origin`.
 * 5. Otherwise operator, per the fail-open rationale in this module's header.
 *
 * Takes `unknown` rather than `RawTurnLine` deliberately. Three different types
 * describe the same stored line in this codebase — `RawTurnLine` on the ingest
 * path, `TranscriptMessage` on the provenance path, `TranscriptLine` in the
 * hooks — and each one DROPS a different subset of the markers read here, which
 * is a large part of why this defect stayed invisible. A parameter typed to any
 * one of them would force the other call sites through casts that assert
 * exactly what this function is built to verify. Every read below is guarded,
 * so an object of the wrong shape yields {@link OPERATOR_ORIGIN} rather than
 * throwing — the same fail-open direction as an unmarked line.
 */
export function classifyUserLineOrigin(line: unknown): UserTextOrigin {
  if (readField(line, "isCompactSummary") === true) return COMPACT_SUMMARY_ORIGIN;
  if (readField(line, "isMeta") === true) return HARNESS_META_ORIGIN;

  const originKind = readOriginKind(line);
  if (originKind !== undefined) return normalizeKind(originKind);

  const promptSource = readPromptSource(line);
  if (promptSource !== undefined && !OPERATOR_PROMPT_SOURCES.has(promptSource)) {
    return normalizeKind(promptSource);
  }

  return OPERATOR_ORIGIN;
}

/**
 * True iff this line's text is genuine operator speech.
 *
 * Compares against {@link OPERATOR_ORIGIN} rather than enumerating the synthetic
 * kinds, so a harness kind nobody has seen yet is treated as NOT-operator by a
 * caller that asks this question — while {@link classifyUserLineOrigin}'s own
 * fail-open still means an UNMARKED line reads as operator. The two defaults
 * point in the same direction: only an explicit non-human marker demotes a line.
 */
export function isOperatorAuthored(line: unknown): boolean {
  return classifyUserLineOrigin(line) === OPERATOR_ORIGIN;
}
