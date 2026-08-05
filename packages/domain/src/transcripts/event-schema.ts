/**
 * Watchable-world semantic event schema v0 (mt#3157, Phase 0 of the
 * watchable-world program).
 *
 * @see RFC (Notion `3a7937f0-3cb4-81ae-8f78-e7a5d5415d0a`) — "The watchable
 *   world — replayable spatial rendering of agent activity". This schema is
 *   the versioned event-sourced substrate the RFC's altitude ladder (ribbon →
 *   score/timeline → stage → territories → habitat) folds over; every
 *   projection re-derives from the same event stream, never from a
 *   renderer-specific side channel.
 * @see event-adapter.ts — transcript → SemanticEvent[] adapter, the only
 *   producer of this schema in Phase 0.
 * @see gource-exporter.ts — the Phase-0 affect probe consumer.
 *
 * ## Monotone-fold obligation (binding design note)
 *
 * A {@link SemanticEvent} models an INTERVAL, not an instant: `tStart` is
 * always known at emission time, `tEnd` may not be (the underlying tool call
 * may still be in flight, or — for a batch adapter reading a complete
 * transcript, as `event-adapter.ts` does in v0 — the adapter may choose not
 * to resolve a completion within its own read window). Any consumer that
 * FOLDS a stream of events into a world-state snapshot (the RFC's fold step)
 * MUST treat a later event carrying the same identifying key (the same
 * `target.id` + `batchId` + `tStart`, or — for a tool-call event — the same
 * underlying `tool_use` id when the adapter later re-emits with resolution)
 * as a REFINEMENT of the earlier one, never a contradiction: an in-flight
 * interval (`tEnd` absent) may later gain a `tEnd`/`outcome`, but a fold must
 * never reverse an already-observed `outcome` or discard an already-folded
 * mutation because a later pass re-derives the same interval. This is a
 * design-note obligation on FUTURE streaming/live-tailing consumers (out of
 * Phase-0 scope per the RFC's stated non-goals) — `event-adapter.ts`'s v0
 * batch adapter always resolves same-turn completions before emitting, so it
 * never itself produces a genuinely in-flight (`tEnd`-absent) event for a
 * tool call; conversational events (`speak`/`think`/`ask`) are point events
 * (`tStart === tEnd` implicitly, `tEnd` omitted) and are never refined.
 */

// ── Schema version ────────────────────────────────────────────────────────────

/** Schema version tag. Bump when the SemanticEvent shape changes incompatibly. */
export const EVENT_SCHEMA_VERSION = "v0" as const;
export type EventSchemaVersion = typeof EVENT_SCHEMA_VERSION;

// ── Verbs ─────────────────────────────────────────────────────────────────────

/**
 * The full verb vocabulary (mt#3157 SC 1). `read`/`search`/`write`/`delete`/
 * `create`/`clone` are PATH-BEARING — they resolve to a stable target id and
 * are eligible for Gource export (see {@link PATH_BEARING_VERBS}).
 * `execute`/`spawn` and the conversational verbs (`wait`/`speak`/`think`/
 * `ask`/`respond`) are first-class in the semantic stream but excluded from
 * the Gource export (RFC revision 3, Amendment 3 — no stable file-system-like
 * path to visualize).
 *
 * ## `think` events usually carry no text (mt#3276, refined mt#3790 — read this
 * before building any thinking-surfacing feature)
 *
 * On the models this project runs, a `think` event's source block arrives
 * empty: Claude Code records
 * `{"type":"thinking","thinking":"","signature":"<~400-1300 chars>"}` — the
 * signature is retained so the block can be replayed to the API for
 * continuity; the reasoning text is not present.
 *
 * ### Why (the mechanism, not the symptom)
 *
 * This is a REQUEST-PARAMETER DEFAULT, not an ingest gap, a storage gap, or a
 * harness property. Anthropic's extended-thinking documentation
 * (platform.claude.com/docs/en/build-with-claude/extended-thinking.md;
 * bundled locally as the `claude-api` skill, §Thinking & Effort) states:
 * `thinking.display` defaults to `"omitted"` on Fable 5 / Mythos 5 / Opus 5 /
 * 4.8 / 4.7 / Sonnet 5, which "streams `thinking` blocks with empty text",
 * while `display: "summarized"` returns a readable summary; `display` controls
 * visibility only — thinking runs and is billed identically under every
 * setting, and the RAW chain of thought is never exposed on any model.
 *
 * Claude Code does not send `display: "summarized"`, so it receives empty
 * blocks and records exactly what it received. Keep the two apart: the raw
 * chain of thought is unavailable everywhere and always; a SUMMARY is
 * available whenever it is requested. Nothing in this file, in
 * `event-adapter.ts`, in the ingest pipeline, or in a hook can recover text
 * the request never asked for — but that is a statement about the request, not
 * about an inherent limit.
 *
 * ### Measurement (dated — re-run it, do not trust it)
 *
 * 2026-08-05, all local `~/.claude/projects/**` corpora newer than 2026-07-25,
 * counting `content[].type === "thinking"` blocks by model:
 *
 * ```
 * 23036 claude-opus-5              EMPTY
 *  6740 claude-fable-5             EMPTY
 *  5858 claude-sonnet-5            EMPTY
 *  2829 claude-opus-4-8            EMPTY
 *   144 claude-opus-4-7            EMPTY
 *    18 claude-haiku-4-5-20251001  EMPTY
 *     5 claude-haiku-4-5-20251001  NONEMPTY
 * ```
 *
 * The five wholly-empty models are exactly the docs' `"omitted"`-default set
 * (minus Mythos 5, absent from the corpus). **Haiku 4.5 is the exception** — it
 * predates the `display` parameter and DOES return thinking prose (verified by
 * reading one: 111 chars of text beside a 484-char signature, Claude Code
 * 2.1.222). So a `think` event CAN carry text; do not write code that assumes
 * otherwise. This supersedes mt#3276's 2026-07-28 reading of `29280 EMPTY /
 * 0 NONEMPTY`, which sampled no Haiku sessions.
 *
 * The block above is a MEASUREMENT WITH A DATE, not a constant. Re-run it
 * before relying on it — the recipe is in mem#889:
 *
 * ```
 * find ~/.claude/projects -name '*.jsonl' -newermt '<date>' -print0 | xargs -0 cat \
 *   | jq -r 'select(.message.content|type=="array") | .message.model as $m
 *       | .message.content[] | select(.type=="thinking")
 *       | "\($m)\t\(if (.thinking//""|length)>0 then "NONEMPTY" else "EMPTY" end)"' \
 *   | sort | uniq -c | sort -rn
 * ```
 *
 * ### For consumers
 *
 * Render an empty thinking block HONESTLY — naming the request default, not a
 * harness limitation — rather than as a load failure or a generic "no content
 * captured"; see `SessionFilmRibbon.tsx`'s `EventContentView`. A NON-empty one
 * needs no special casing: render it like any other text.
 */
export const EVENT_VERBS = [
  "read",
  "search",
  "write",
  "delete",
  "execute",
  "create",
  "spawn",
  "clone",
  "wait",
  "speak",
  "think",
  "ask",
  "respond",
] as const;
export type EventVerb = (typeof EVENT_VERBS)[number];

/**
 * Default weight per verb — the "how much does this event count" signal a
 * future score/timeline projection (RFC altitude A1) folds over. Deliberately
 * coarse in v0: mutation-shaped verbs (`write`/`create`/`delete`/`clone`)
 * outweigh read-shaped verbs (`read`/`search`/`execute`); `spawn` (delegating
 * to a whole subagent) is the heaviest single verb; purely-internal verbs
 * with no externally observable effect (`think`, `wait`) weigh zero. Per-verb
 * weight is intentionally a flat table (not tool-specific) — Phase 0 does not
 * need per-tool weight tuning; see the RFC's altitude ladder for where a
 * richer weighting scheme would plug in.
 */
export const DEFAULT_VERB_WEIGHTS: Readonly<Record<EventVerb, number>> = {
  read: 1,
  search: 1,
  write: 2,
  delete: 2,
  execute: 1,
  create: 2,
  spawn: 3,
  clone: 2,
  wait: 0,
  speak: 1,
  think: 0,
  ask: 1,
  respond: 1,
};

/** Look up the default weight for a verb. */
export function weightForVerb(verb: EventVerb): number {
  return DEFAULT_VERB_WEIGHTS[verb];
}

/**
 * Verbs with a stable, path-like target — eligible for the Gource exporter
 * (RFC revision 3, Amendment 3). `execute` (a shell command has no durable
 * path) and `spawn` (a new agent, not a file mutation) are deliberately
 * excluded alongside the conversational verbs — see `gource-exporter.ts` for
 * the consuming filter.
 */
export const PATH_BEARING_VERBS: readonly EventVerb[] = [
  "read",
  "search",
  "write",
  "create",
  "delete",
  "clone",
];

/** True iff `verb` is eligible for Gource export (see {@link PATH_BEARING_VERBS}). */
export function isPathBearingVerb(verb: EventVerb): boolean {
  return (PATH_BEARING_VERBS as readonly string[]).includes(verb);
}

// ── Actors ────────────────────────────────────────────────────────────────────

/**
 * Actor kinds (mt#3157 SC 1):
 *   - `agent` — a main or spawned agent conversation. `agentSessionId` names
 *     which one (this transcript's own id for its assistant-role turns; the
 *     PARENT's agent session id for a spawned child's user-role turns per
 *     RFC Amendment 2).
 *   - `principal` — the human's own turns in a TOP-LEVEL conversation only.
 *     Never used for a transcript linked as a spawn child (Amendment 2).
 *   - `policy` — a guard/hook denial. `guardName` is a receipt ref back to
 *     the guard doc (`hook-files.mdc`) when extractable from the denial text.
 */
export const EVENT_ACTOR_KINDS = ["agent", "principal", "policy"] as const;
export type EventActorKind = (typeof EVENT_ACTOR_KINDS)[number];

export interface EventActor {
  kind: EventActorKind;
  /** Set when `kind === "agent"` — the acting agent's harness conversation id. */
  agentSessionId?: string;
  /**
   * Optional human-readable label for an `agent` actor (e.g. the mt#2770
   * content-derived conversation label — a bound task title or first-prompt
   * snippet). Callers with cheap access to it (see
   * `scripts/export-gource-log.ts`) should set it; display consumers (e.g.
   * the Gource exporter's actor field) should prefer this over the raw
   * `agentSessionId`, which is unreadable as a rendered avatar name.
   */
  displayLabel?: string;
  /** Set when `kind === "policy"` — the guard/hook name, when extractable. */
  guardName?: string;
}

// ── Outcomes ──────────────────────────────────────────────────────────────────

export const EVENT_OUTCOMES = ["ok", "error", "denied"] as const;
export type EventOutcome = (typeof EVENT_OUTCOMES)[number];

// ── Realms / targets ──────────────────────────────────────────────────────────

/**
 * Coarse target realms (mt#3157 Scope; RFC Amendment 5's "sectors, not
 * cartography" framing). `unknown` is reserved for the total-fallback path
 * (an unmapped tool with no inferable realm) — see `event-adapter.ts`'s
 * coverage metric.
 */
export const EVENT_REALMS = [
  "repo",
  "minsky-substrate",
  "web",
  "notion",
  "shell",
  "agents",
  "unknown",
] as const;
export type EventRealm = (typeof EVENT_REALMS)[number];

/**
 * A synthetic composite target id (RFC Amendment 5). Deliberately distinct
 * from the five-type `minsky://` deeplink codec (`cockpit-deeplinks.mdc`),
 * which stays reserved for Minsky's own entity URIs — these ids are an
 * internal node-graph key for the fold, not a user-facing link.
 *
 * Observed id shapes (see `event-adapter.ts`'s target extractors):
 *   - `file:<repoRoot>:<path>` — a repo-realm file.
 *   - `web:<domain>` — a web-realm resource, domain grain (query stripped).
 *   - `notion:<pageId>` — a notion-realm page.
 *   - `minsky:<entityKind>:<id>` — a minsky-substrate entity (task, session,
 *     changeset, memory, ...).
 *   - `shell:<command-digest>` — a shell-realm command.
 *   - `agents:<agentSessionId|agentKind>` — an agents-realm actor reference.
 */
export interface EventTarget {
  realm: EventRealm;
  id: string;
  /** Raw tool-specific reference (full path/url/command) for richer downstream consumers. */
  raw?: unknown;
}

// ── Source back-reference (mt#3262 SC 1) ────────────────────────────────────────

/**
 * Back-reference from a `SemanticEvent` to the transcript line (and, for a
 * tool-call-derived event, the specific tool call within that line) it was
 * derived from. Optional/additive — existing consumers that never read this
 * field are unaffected.
 *
 * `turnIndex` is the PRIMARY join key: the adapter's own loop index over the
 * `TranscriptMessage[]` array (`event-adapter.ts`'s `adaptTranscriptToEvents`),
 * which is index-identical with `assembleSessionContextSnapshot`'s
 * `SessionContextSnapshotBlock.turnIndex` (`session-context-snapshot.ts`) —
 * both iterate the SAME `agent_transcripts.transcript` array returned
 * verbatim by `AgentTranscriptService.getTranscript()`. See
 * `event-adapter.test.ts`'s AT1 round-trip test for the identity this rests
 * on.
 *
 * `toolUseId` is REQUIRED to disambiguate a tool-call-derived event: one
 * assistant line can emit many tool-call events sharing one `batchId` and one
 * `turnIndex` (a parallel tool batch), so `turnIndex` alone cannot say WHICH
 * call a given event is. Conversational events (`speak`/`think`/`ask`) leave
 * it `undefined` — they are not tool calls.
 */
export interface EventSourceRef {
  /** 0-indexed position in the transcript array (see doc comment above). */
  turnIndex: number;
  /** The originating JSONL line's `uuid`, when present — free, stable across re-ingest. */
  messageUuid?: string;
  /** The `tool_use` block's id, set only for tool-call-derived events (see doc comment above). */
  toolUseId?: string;
}

// ── The event ─────────────────────────────────────────────────────────────────

/**
 * One semantic event — an interval `(t_start, t_end?, actor, verb, target,
 * outcome, weight?, batchId?, adapterVersion)` per mt#3157 SC 1. See the
 * module doc comment above for the monotone-fold obligation this interval
 * shape carries.
 */
export interface SemanticEvent {
  schemaVersion: EventSchemaVersion;
  /** ISO-8601 timestamp — ISO string kept (not a Date) so events serialize stably. */
  tStart: string;
  /** ISO-8601 timestamp of resolution, when known within the adapter's read window. */
  tEnd?: string;
  actor: EventActor;
  verb: EventVerb;
  target: EventTarget;
  /**
   * `undefined` means UNRESOLVED/in-flight — the adapter observed a tool
   * call but could not pair it with a completion (no matching `tool_result`
   * in the following user-role line) within its read window. This is
   * intentionally distinct from `"ok"`: an unpaired call is unknown, not
   * successful, and overstating it as `"ok"` is exactly the "confident
   * misreading" the RFC's affect goal warns against. Consistent with the
   * module doc comment's monotone-fold obligation — `outcome` (like `tEnd`)
   * is one of the fields a later-arriving completion REFINES; a fold must
   * never treat an absent `outcome` as `"ok"` by default. Conversational
   * events (`speak`/`think`/`ask`) are point events with no pairing step, so
   * they always carry a resolved `"ok"` outcome.
   */
  outcome?: EventOutcome;
  /** Defaults to {@link weightForVerb}`(verb)` when omitted by a consumer. */
  weight?: number;
  /**
   * Marks genuinely simultaneous parallel batches: all tool_use blocks on one
   * assistant transcript line share one `batchId` and one `tStart` — and a
   * single tool_use that resolves to multiple sibling targets (RFC Amendment
   * 4, e.g. a multi-domain search) reuses the SAME mechanism. Consumers must
   * never invent an order within a shared `batchId`.
   */
  batchId?: string;
  /** Adapter contract version that produced this event (independent of {@link EVENT_SCHEMA_VERSION}). */
  adapterVersion: string;
  /**
   * Set (true/false) only for TOOL-CALL-derived events: true when the source
   * tool name did not match any registry entry and fell back to the generic
   * `execute` mapping (mt#3157 SC 2). Left `undefined` for conversational
   * events (`speak`/`think`/`ask`), which are not tool calls and therefore
   * not part of the coverage-metric denominator — see
   * `event-adapter.ts`'s `computeAdapterCoverage`.
   */
  unmapped?: boolean;
  /**
   * Back-reference to the originating transcript line (mt#3262 SC 1). Set by
   * `event-adapter.ts` for every event it emits; see {@link EventSourceRef}'s
   * doc comment for the join-key discipline this rests on.
   */
  sourceRef?: EventSourceRef;
}
