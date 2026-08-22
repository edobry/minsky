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

import { PROMPT_WATERMARK } from "../session/prompt-generation";

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
 * A dispatch brief: the prompt a PARENT AGENT composed to instruct a subagent,
 * landing as the first `user`-role line of the subagent's transcript (mt#4401).
 *
 * Not a harness product — Minsky writes it. Which is exactly why the four
 * harness fields above are all absent from the record, so before this kind
 * existed it fell through to {@link OPERATOR_ORIGIN} and an agent-composed
 * prompt was filed as the operator's own words. Verified against
 * `<project>/subagents/agent-a335fb8b0e7586511.jsonl` line 1, whose key set is
 * `agentId, cwd, entrypoint, gitBranch, isSidechain, message, parentUuid,
 * promptId, sessionId, timestamp, type, userType, uuid, version` — no
 * `isCompactSummary`, no `isMeta`, no `origin`, no `promptSource`.
 *
 * Measured 2026-08-21: 400 of 763 local subagent transcripts carry a marker on
 * that first line, and the corpus grows with every dispatch.
 */
export const DISPATCH_BRIEF_ORIGIN: UserTextOrigin = "dispatch_brief";

/**
 * The mt#2292 dispatch stamp's version token — THE definition (PR #3242 R2).
 *
 * Lives here rather than in `.minsky/hooks/agent-dispatch-stamp.ts`, which
 * imports it, because a dispatch stamp is transcript vocabulary that two sides
 * share: the hook WRITES it into a prompt, this module READS it back out.
 *
 * The first attempt duplicated it here with a sync test, on the assumption that
 * `packages/domain` cannot import from the hook tree. The premise was right and
 * the conclusion was backwards — hooks import from `@minsky/domain` routinely
 * (`block-nested-fork-dispatch.ts`, `dispatch-intent-store.ts`), so the
 * dependency inverts cleanly and one definition serves both. A sync test is a
 * detector for drift; a single definition makes drift unrepresentable.
 */
export const DISPATCH_STAMP_VERSION = "minsky:dispatch:v1";

/**
 * Does this text carry a marker Minsky itself wrote to mark an agent-composed
 * dispatch prompt?
 *
 * **Why a text check does not violate mt#4289's "structural, never
 * text-prefix" rule.** That rule has two stated reasons and neither reaches a
 * marker we emit. AMBIGUITY: a prefix cannot separate an operator pasting
 * `Base directory for this skill:` from the harness emitting it — a versioned
 * HTML comment our own `prompt-generation.ts` writes is not text an operator
 * produces incidentally. INSTABILITY: the harness is a vendor whose prose we do
 * not control, whereas `PROMPT_WATERMARK` is ours, versioned, and any change to
 * it is a greppable change in this repo. The rule is really *read the
 * provenance the writer recorded, not the shape of the prose* — and for a
 * dispatch the prompt body is the only channel that provably crosses the
 * boundary (`agent-dispatch-stamp.ts`'s own docblock says so).
 *
 * **`TASK_PROMPT_WATERMARK` is deliberately NOT in this set (mt#4401).**
 * `<!-- minsky:task-prompt:v1 -->` marks the prompts `tasks decompose|estimate|
 * analyze` generate FOR A HUMAN TO PASTE. A turn carrying it is therefore
 * genuinely the operator speaking, and keying on it would misattribute in the
 * opposite direction — a live instance of mt#3405's hazard rather than a
 * hypothetical one. Adding a Minsky watermark here is not automatic: ask who
 * the marked text is written BY, not merely who wrote the marker.
 */
function carriesDispatchMarker(text: string): boolean {
  return text.includes(PROMPT_WATERMARK) || text.includes(DISPATCH_STAMP_VERSION);
}

/**
 * Structural corroboration that this record IS a dispatch, not prose ABOUT one.
 *
 * `isSidechain` / `agentId` are both present on a real subagent transcript's
 * opening line and absent from an ordinary conversation turn. Used ONLY as a
 * conjunct with {@link carriesDispatchMarker} — never alone, which is the
 * distinction that matters and the reason the sibling test asserting
 * "isSidechain is NOT the discriminator" still holds. Alone it labels by
 * LOCATION rather than authorship, so an operator message inside a sidechain
 * would be mislabeled; paired with a marker it answers a different and
 * answerable question — is this the record a dispatch produced?
 *
 * The cost, stated: a watermark-bearing turn in a ROOT conversation is no
 * longer classified `dispatch_brief`. Measured at 1 such turn against the
 * misclassification risk this removes, and the fail-open-to-operator policy
 * says to err this way.
 */
function isSubagentRecord(line: unknown): boolean {
  if (readField(line, "isSidechain") === true) return true;
  const agentId = readField(line, "agentId");
  return typeof agentId === "string" && agentId.trim().length > 0;
}

/** The text a user-role line carries, whether `content` is a string or blocks. */
function userLineText(line: unknown): string | null {
  const message = readField(line, "message");
  const content = readField(message, "content");
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter(
      (b): b is { type: string; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string"
    )
    .map((b) => b.text);
  return parts.length > 0 ? parts.join("\n") : null;
}

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
 * 5. A Minsky dispatch marker in the TEXT **and** structural corroboration that
 *    the record is a subagent transcript's. The marker is the only signal a
 *    dispatch prompt carries, since it is ours rather than the harness's; the
 *    corroborator is what stops an operator QUOTING one from matching. Last, so
 *    any explicit harness verdict above outranks both.
 * 6. Otherwise operator, per the fail-open rationale in this module's header.
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

  // mt#4401 — LAST before the fail-open, and deliberately so. A Minsky dispatch
  // prompt carries none of the four harness fields above, so this is the only
  // check that can catch it; putting it last means an explicit harness verdict
  // always wins.
  //
  // BOTH conjuncts are required (PR #3242 R1, BLOCKING). The marker alone
  // misclassifies an operator who QUOTES a watermark in a message the harness
  // never stamped — pre-`origin` history, or any unstamped line. That is not
  // hypothetical: mt#3405 records `check-prompt-watermark` false-positiving on
  // exactly this prose. The corroborator is what separates "this text mentions
  // a watermark" from "this record IS a dispatch".
  const text = userLineText(line);
  if (text !== null && carriesDispatchMarker(text) && isSubagentRecord(line)) {
    return DISPATCH_BRIEF_ORIGIN;
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
