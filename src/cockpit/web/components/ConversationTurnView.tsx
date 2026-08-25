/**
 * Turn-grain rendering for a transcript thread (mt#4024).
 *
 * Everything here was moved VERBATIM out of `widgets/ConversationView.tsx`,
 * which had grown past its 1500-line ceiling again and — more to the point —
 * was the only place that knew how to turn a `PreparedTurn` into a rendered
 * exchange. The published share page (`pages/SharedConversationPage.tsx`) has
 * to render the same thread for someone with no account, and a second
 * implementation of it would drift from this one the first time either
 * changed.
 *
 * The split line is deliberate: this module renders TURNS and knows nothing
 * about where they came from. Fetching, windowing, scroll pinning, live tail,
 * and the expand-all broadcast all stay in `ConversationView` — the share page
 * wants none of them.
 *
 * This is the third extraction from that file and it follows the same shape as
 * the first two: the single-element renderers went to
 * `ConversationElementRenderers.tsx` (mt#3262), the pure assembly passes went
 * to `lib/conversation-turn-assembly.ts` (mt#3791).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "../lib/utils";
import {
  groupActionBursts,
  summarizeBurst,
  type BurstNode,
} from "../lib/conversation-action-bursts";
import { SYNTHETIC_MODEL_SENTINEL } from "@minsky/domain/ai/dispatch-models";
import type { ConversationTurn } from "@minsky/domain/transcripts/conversation-elements";
import type { EntityIndex } from "../lib/entity-linkifier";
import {
  BURST_CHILDREN,
  DisclosureChevron,
  ElementView,
  FOCUS_RING,
  HOVER_ROW,
  SpawnBadge,
  type ExpandSignal,
  type PreparedElement,
} from "./ConversationElementRenderers";
import {
  SupersededPromptMarker,
  supersededMarkerKey,
  type SupersededGroup,
} from "./SupersededPromptMarker";
import {
  classifyOutcome,
  OUTCOME_TONE,
  type ConversationOutcome,
} from "../lib/conversation-outcome";
import {
  ADDRESSED_MARK_CLASS,
  TURN_ANCHOR_ATTR,
  TURN_ELEMENTS_TESTID,
  type TurnAddress,
} from "../lib/conversation-turn-address";
import { FilmMomentLink } from "./FilmMomentLink";
import type { PreparedTurn } from "../lib/conversation-turn-assembly";
import { formatLocalTime, turnSeparator } from "../lib/conversation-timeline";
import { TurnSeparatorRow } from "./ThreadOrientation";
import { classifyTurnOrigin } from "../lib/turn-origin";
import { modelTierLabel } from "@minsky/domain/ai/dispatch-models";

// ── Time formatting ─────────────────────────────────────────────────────────────

function formatTime(iso: string): string {
  try {
    return formatLocalTime(iso);
  } catch {
    return iso;
  }
}

// ── Element renderers ──────────────────────────────────────────────────────────
//
// The single-element renderers (ThinkingBlock, ToolInvocation, ToolResult,
// InjectedContentBlock, ElementView) live in `../components/
// ConversationElementRenderers.tsx` (mt#3262 SC 2 extraction) — imported
// above, not redefined here, so the session-film ribbon's expanded row can
// share the exact same rendering code.

// ── Pre-render turn assembly ───────────────────────────────────────────────────
//
// Tool-call/result pairing (mt#2790) and slash-command folding (mt#3322) live in
// `../lib/conversation-turn-assembly.ts` — pure functions over turns, moved out
// verbatim when this file hit its 1500-line ceiling (mt#3791), the same way the
// per-element renderers went to `ConversationElementRenderers.tsx` before them.
// `PreparedTurn` is defined there too, since both passes are typed on it.

/**
 * The per-turn Outcome chip's value, or `null` when none is evidenced.
 *
 * The vocabulary, the precedence rules, and the `Errored`-vs-`Rate-limited`
 * split all live in `../lib/conversation-outcome.ts` (mt#3132) — ONE
 * terminal-condition taxonomy shared with the session driver channel's status
 * readout, replacing the per-pipeline enums that had drifted apart. This
 * function is now only the transcript ADAPTER: it extracts the evidence a turn
 * carries and hands it to the shared classifier.
 *
 * An unremarkable turn still yields `null` rather than `Completed` — see that
 * module's docblock for why asserting completion without a completion signal is
 * the falsely-confident derived field this umbrella exists to remove.
 */
function elementIsInterruption(element: PreparedElement): boolean {
  if (element.kind === "tool-invocation") return element.result?.isInterruptionRejection === true;
  if (element.kind === "tool-result-orphan") return element.result.isInterruptionRejection === true;
  return false;
}

function turnOutcome(turn: PreparedTurn): ConversationOutcome | null {
  if (turn.role !== "assistant") return null;
  return classifyOutcome({
    source: "transcript",
    interrupted: turn.elements.some(elementIsInterruption),
    texts: turn.elements.flatMap((el) => (el.kind === "text" ? [el.text] : [])),
  });
}

// The synthetic-retry sentinel was declared here, then moved to
// `lib/conversation-action-bursts.ts` (mt#4250) when the burst predicate needed
// it too. mt#4237 finished the job: it now has ONE declaration repo-wide, in
// `@minsky/domain/ai/dispatch-models`, imported directly above. Three copies
// with nothing checking they agreed is what that task removed.

/**
 * A context-compaction boundary (mt#3260).
 *
 * Claude Code injects its own summary as a `user` line carrying
 * `isCompactSummary: true`. Rendering it as ordinary user prose is what makes
 * it read as "an unmarked giant user turn" — the operator sees a wall of text
 * they never typed, with no indication their context was just reset. This
 * replaces the turn body with a labeled boundary; the summary itself stays
 * reachable behind the disclosure so nothing is hidden.
 */
function CompactionBoundary({
  turn,
  entityIndex,
  expandSignal,
}: {
  turn: PreparedTurn;
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
}) {
  return (
    <details
      className="rounded border border-border/60 bg-muted/20 px-2 py-1"
      data-testid="compaction-boundary"
    >
      <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-muted-foreground">
        Context compacted here
        <span className="ml-2 normal-case tabular-nums text-muted-foreground/60">
          {formatTime(turn.timestamp)}
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {turn.elements.map((element, i) => (
          <ElementView
            key={i}
            element={element}
            role={turn.role}
            entityIndex={entityIndex}
            expandSignal={expandSignal}
          />
        ))}
      </div>
    </details>
  );
}

// `ElementView` is imported above from `../components/
// ConversationElementRenderers` (mt#3262 SC 2) — see that module for the
// per-`PreparedElement`-kind render switch.

// Role → left accent + label styling for the thread.
const ROLE_STYLES: Record<ConversationTurn["role"], { accent: string; label: string }> = {
  user: { accent: "border-l-emerald-500/50", label: "user" },
  assistant: { accent: "border-l-sky-500/40", label: "assistant" },
  other: { accent: "border-l-border", label: "other" },
};

/**
 * Accent for a harness-authored turn (mt#3374). Deliberately NOT the `user`
 * emerald: that accent is the operator's own voice in this thread, and reusing
 * it for content they did not write is the visual half of the same
 * misattribution the label fix addresses.
 */
const HARNESS_ACCENT = "border-l-border";

// ── Run grouping (mt#3845 SC1) ─────────────────────────────────────────────────
//
// A `PreparedTurn` is derived one-per-snapshot-block, and Claude Code emits a
// new assistant block for every text segment and every tool call. So a single
// continuous stretch of agent work is many turns, and labelling each one put a
// stack of identical `ASSISTANT` headers down the page: measured over the 30
// most recent local transcripts (2026-08-17), a run of consecutive assistant
// blocks between operator messages has a MEDIAN length of 31, a p90 of 142 and
// a max of 320.
//
// The header belongs to the RUN, not the block. What identifies a run is the
// ACTOR, not the role — principal decision, ask#7348 (2026-08-08), option (a):
// "actor identity … once per run", with option (b)'s discipline underneath, so
// typography carries the boundary and a text label renders ONLY where real
// actor data exists.
//
// This is the third pre-render pass over turns, after `pairToolInvocations` and
// `mergeCommandInvocations` (`../lib/conversation-turn-assembly.ts`). It lives
// HERE rather than beside them because a run must break wherever the thread
// interleaves something between two turns — a day/gap separator, a rewind
// marker, a compaction boundary — and only `buildTurnNodes` below knows where
// those land. Grouping in isolation would silently swallow them into a
// contiguous block, which reads as though a rewind marker were agent output.

/**
 * The identity a run is grouped by. Two adjacent turns join the same run only
 * when these match EXACTLY.
 *
 * `model` is included so a model switch splits the run and is therefore VISIBLE
 * — the label stops being decoration and starts carrying information. It also
 * gives the `<synthetic>` retry sentinel (mt#3260) its own run for free, which
 * is what keeps a harness retry from hiding inside a real model's block.
 */
interface ActorKey {
  role: ConversationTurn["role"];
  /** Per-origin harness label (mt#3374), or `null` for a non-harness turn. */
  harnessLabel: string | null;
  /** Raw recorded model id — compared verbatim, rendered as a tier. */
  model: string | null;
}

function actorKeyOf(turn: PreparedTurn): ActorKey {
  const origin = classifyTurnOrigin(turn);
  return {
    role: turn.role,
    harnessLabel: origin?.kind === "harness" ? origin.label : null,
    model: turn.model ?? null,
  };
}

function sameActor(a: ActorKey, b: ActorKey): boolean {
  return a.role === b.role && a.harnessLabel === b.harnessLabel && a.model === b.model;
}

/**
 * What the run's ONE header says, or `null` for "say nothing".
 *
 * `null` is a first-class answer, not a fallback: an assistant run whose model
 * the transcript never recorded renders no actor claim at all, and the rail
 * plus spacing carry the speaker. Naming the role instead would put back the
 * exact word ask#7348 retired, and defaulting to a model would assert something
 * unverified — which is why the ask's own option text calls out that an unknown
 * actor "must render as nothing, never a guessed default."
 *
 * Note what is deliberately NOT here: the `main ·` / `implementer ·` prefix from
 * the ask's example. That distinction is a property of the CONVERSATION (is this
 * transcript the main agent's or a dispatched subagent's), and no field on a
 * turn carries it — `isSpawnBoundary` marks a turn that SPAWNED a child, which
 * is a different question. Rendering it would be the guessed default the same
 * sentence forbids. When conversation-grain actor data reaches this component,
 * it prefixes here.
 */
function runLabelOf(key: ActorKey): string | null {
  if (key.harnessLabel !== null) return key.harnessLabel;
  if (key.role === "assistant") return modelTierLabel(key.model) ?? null;
  return ROLE_STYLES[key.role].label;
}

function runAccentOf(key: ActorKey): string {
  if (key.harnessLabel !== null) return HARNESS_ACCENT;
  return ROLE_STYLES[key.role].accent;
}

/**
 * ONE turn inside a run (mt#3845 SC1).
 *
 * Carries no actor label and no rail — those belong to the {@link RunView}
 * around it. What stays per-segment is everything that is a property of THIS
 * block and would be a misattribution one level up: the `data-turn-index`
 * anchor that turn addresses, the addressed-mark ring and film moments resolve
 * against; the outcome chip; the `Retrying…` chip; the spawn badge; and the
 * hover film link. Hoisting any of those to the run header would attribute one
 * block's error, retry or spawn to a stretch that can be 300 blocks long.
 */
function TurnSegment({
  turn,
  entityIndex,
  expandSignal,
  turnIndex,
  address,
  filmPath,
}: {
  turn: PreparedTurn;
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
  /** Film-tab path enabling the "watch this moment" link (mt#3794). */
  filmPath?: string;
  /**
   * The transcript position this turn came from, when known (mt#3791) — the
   * anchor a turn address resolves against. `undefined` for a live-tail block
   * the snapshot never stamped, which is simply unaddressable.
   */
  turnIndex?: number;
  /** Set only on the turn an address named; every other turn gets `undefined`. */
  address?: TurnAddress;
}) {
  // Who authored the turn is now decided one level up, in `actorKeyOf` — a
  // segment inherits its run's actor by construction, so re-deriving it here
  // would be a second answer to a settled question. Compaction summaries are
  // likewise routed by `buildTurnNodes`, which emits them standalone rather
  // than inside a run.
  const outcome = turnOutcome(turn);
  const isRetry = turn.model === SYNTHETIC_MODEL_SENTINEL;

  const rendered = turn.elements
    .map((element, i) => {
      const node = (
        <ElementView
          key={i}
          element={element}
          role={turn.role}
          entityIndex={entityIndex}
          expandSignal={expandSignal}
          addressedToolUseId={address?.toolUseId}
          filmPath={filmPath}
          turnIndex={turnIndex}
        />
      );
      return node;
    })
    .filter(Boolean);

  // A tool-grain address marks the CALL, not the turn around it — the reader
  // asked for one action out of a batch, and ringing the whole turn would put
  // the mark on the wrong grain. A turn-grain address has no finer target, so
  // the turn itself carries it.
  const marked = address !== undefined && address.toolUseId === undefined;

  // A turn with no renderable elements (e.g. an empty pairing) is skipped by the caller.
  return (
    <div
      {...(turnIndex === undefined ? {} : { [TURN_ANCHOR_ATTR]: turnIndex })}
      // Exact per-block time, on hover. The run header carries the one VISIBLE
      // clock; dropping the other N-1 is most of this change's density win, and
      // `title` keeps each block's own value reachable rather than deleted.
      title={formatTime(turn.timestamp)}
      className={cn(
        // NAMED group (mt#3794): a tool call inside this turn has its own
        // hover-revealed film link, and an unnamed `group` would make hovering
        // anywhere in the turn reveal every call's link at once.
        // `relative` hosts the film link, which is now absolutely positioned so
        // a segment with no chips costs no row at all.
        "group/turn relative flex flex-col gap-2",
        marked && ADDRESSED_MARK_CLASS,
        // Keeps the landing clear of the sticky header a scroll-into-view would
        // otherwise tuck the turn under (the same reason the tail sentinel
        // carries `scroll-mb-8`, mt#3344).
        "scroll-mt-16"
      )}
    >
      {/*
        Chips only, and only when there ARE chips — an unremarkable segment
        renders no meta row whatsoever. That conditional is the other half of
        the density win: the common segment is now just its elements.
      */}
      {(turn.isSpawnBoundary || isRetry || outcome !== null) && (
        <div
          className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground"
          data-testid="turn-chips"
        >
          {turn.isSpawnBoundary && (
            <SpawnBadge
              spawn={{
                agentKind: turn.spawnAgentKind,
                childAgentSessionId: turn.spawnChildAgentSessionId,
              }}
            />
          )}
          {isRetry && (
            <span
              className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium normal-case text-muted-foreground"
              title="Harness-generated retry turn (model: <synthetic>), not a model response"
              data-testid="turn-retrying"
            >
              Retrying…
            </span>
          )}
          {outcome && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium normal-case",
                OUTCOME_TONE[outcome]
              )}
              data-testid="turn-outcome"
            >
              {outcome}
            </span>
          )}
        </div>
      )}
      {/*
        `data-testid` is load-bearing, not a test convenience (mt#4278).
        `scripts/verify-conversation-weight.ts` needs to address THIS wrapper to
        find assistant speech, and it used to do so positionally, as
        `[data-turn-index] > div:last-child`. mt#3845 then moved the film link
        below this div, so the last child became an `<a>`, no div matched, and
        the script's prose count silently went to zero — taking with it the one
        assertion no unit test can make. A named anchor survives any number of
        trailing siblings; a positional one waits for the next change to add
        one.
      */}
      <div data-testid={TURN_ELEMENTS_TESTID} className="flex flex-col gap-2">
        {rendered}
      </div>
      {/*
        Turn-grain film link (mt#3794). Gated on a KNOWN `turnIndex`: a
        live-tail block the snapshot never stamped has no address, so there is
        no moment to link to — the same condition that makes it unaddressable
        from the film's side.

        Absolutely positioned as of mt#3845: it used to share the per-turn meta
        row, and that row is now conditional on chips — which nearly every
        segment lacks. Taking it out of flow keeps the affordance on every
        addressable segment without putting the row back.
      */}
      {filmPath !== undefined && turnIndex !== undefined && (
        <FilmMomentLink
          address={{ turnIndex }}
          filmPath={filmPath}
          className="absolute right-0 top-0 group-hover/turn:opacity-100"
        />
      )}
    </div>
  );
}

/**
 * Shared by {@link RunView} and {@link BurstFold} — everything a `TurnSegment`
 * needs that is a property of the RUN rather than of the turn.
 */
interface SegmentContext {
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
  turnIndexByBlockId: Map<string, number>;
  address?: TurnAddress;
  addressedBlockId?: string;
  filmPath?: string;
}

function renderSegment(turn: PreparedTurn, ctx: SegmentContext): ReactNode {
  return (
    <TurnSegment
      key={turn.blockId}
      turn={turn}
      entityIndex={ctx.entityIndex}
      expandSignal={ctx.expandSignal}
      turnIndex={ctx.turnIndexByBlockId.get(turn.blockId)}
      address={turn.blockId === ctx.addressedBlockId ? ctx.address : undefined}
      filmPath={ctx.filmPath}
    />
  );
}

/**
 * A folded stretch of machinery turns, standing behind one summary line (mt#4250).
 *
 * Collapsed by default; expanding renders the very same `TurnSegment`s the
 * thread would have rendered without the fold, which is what makes expansion
 * lossless rather than a second, lossier rendering of the same turns.
 *
 * The control stays visible when open so the burst can be closed again, and it
 * carries a hover treatment because — unlike the reference terminal, which
 * expands via a global `ctrl+o` — a fold line here IS the only way in. mt#4220
 * removed the border that used to delimit rows as objects, and mt#4251 is
 * restoring that affordance for the per-call rows; this control ships with it
 * from the start rather than inheriting the gap.
 */
function BurstFold({ turns, ctx }: { turns: PreparedTurn[]; ctx: SegmentContext }) {
  // A deep link that lands inside a fold must not land on a closed one — the
  // reader navigated to a specific call, and hiding it is the worst version of
  // this feature. Recomputed rather than captured so an address arriving after
  // mount (the resolve-then-scroll path) still opens it.
  const containsAddressed =
    ctx.addressedBlockId !== undefined &&
    turns.some((turn) => turn.blockId === ctx.addressedBlockId);

  const [open, setOpen] = useState(containsAddressed);

  useEffect(() => {
    if (containsAddressed) setOpen(true);
  }, [containsAddressed]);

  // Re-sync on a NEW expand-all/collapse-all broadcast only (epoch), never on
  // every `expandSignal.open` identity change — the same discipline
  // `ToolInvocation` uses, and for the same reason: the signal is a fresh
  // object per click by design.
  const expandEpoch = ctx.expandSignal?.epoch;
  useEffect(() => {
    if (ctx.expandSignal) setOpen(ctx.expandSignal.open);
  }, [expandEpoch]);

  const summary = useMemo(() => summarizeBurst(turns), [turns]);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="action-burst-toggle"
        className={cn(
          "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs",
          // Dim at rest so a fold recedes exactly as far as the rows it
          // replaced; legible the moment a pointer is over it. The background
          // half moved to the shared HOVER_ROW (mt#4251) — this control shipped
          // a hand-picked `bg-muted/40` one task before the four disclosure
          // controls beside it gained the same affordance, and two adjacent
          // values in one view is the drift that constant exists to stop.
          "text-muted-foreground hover:text-foreground",
          HOVER_ROW,
          FOCUS_RING
        )}
      >
        <DisclosureChevron open={open} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </button>
      {open && (
        // The children are CONTAINED, not merely revealed (mt#4348). Before
        // this they were plain siblings of the toggle in the same column, so an
        // expanded fold's turns rendered identically to top-level turns and the
        // reader could not see which fold they belonged to — the principal's
        // "information hierarchy for the collapsible section's outer and inner
        // elements is non obvious". `BURST_CHILDREN` carries the rail and the
        // indent; the leading chevron above is what makes that indent legible
        // as depth rather than as a stray margin.
        <div className={BURST_CHILDREN} data-testid="action-burst-children">
          {turns.map((turn) => renderSegment(turn, ctx))}
        </div>
      )}
    </div>
  );
}

/**
 * ONE contiguous run of same-actor turns, under ONE header (mt#3845 SC1).
 *
 * The rail and the left padding move here from the per-turn wrapper, so a run
 * reads as one continuous block of that actor's work rather than as N adjacent
 * blocks — which is the whole complaint: the rail already marked the speaker,
 * and repeating a label beside it every block added nothing and cost a row.
 *
 * The header renders a label only when {@link runLabelOf} yields one. A run
 * with no resolvable actor still gets its header row for the clock; it simply
 * makes no claim about who is speaking.
 */
function RunView({
  turns,
  entityIndex,
  expandSignal,
  turnIndexByBlockId,
  address,
  addressedBlockId,
  filmPath,
}: {
  turns: PreparedTurn[];
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
  turnIndexByBlockId: Map<string, number>;
  address?: TurnAddress;
  addressedBlockId?: string;
  filmPath?: string;
}) {
  const first = turns[0];
  if (first === undefined) return null;

  const key = actorKeyOf(first);
  const label = runLabelOf(key);
  const last = turns[turns.length - 1];

  const startTime = formatTime(first.timestamp);
  const endTime = last === undefined ? startTime : formatTime(last.timestamp);
  // A single-block run, or one that opened and closed inside the same rendered
  // minute, shows one clock rather than `14:12 → 14:12`.
  const timeLabel = endTime === startTime ? startTime : `${startTime} → ${endTime}`;

  const ctx: SegmentContext = {
    entityIndex,
    expandSignal,
    turnIndexByBlockId,
    address,
    addressedBlockId,
    filmPath,
  };
  // Computed on every render rather than memoized: this component sits after an
  // early return, so a hook here would be conditional. The pass is a single
  // linear walk over turns already in hand — cheaper than the memo's own
  // dependency comparison on a `turns` array that is a fresh slice each render.
  const nodes: BurstNode[] = groupActionBursts(turns);

  return (
    <div className={cn("flex flex-col gap-2 border-l-2 pl-3", runAccentOf(key))}>
      <div
        className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground"
        data-testid="run-header"
      >
        {label !== null && (
          <span className="font-semibold" data-testid="turn-role-label">
            {label}
          </span>
        )}
        <span className="ml-auto tabular-nums text-muted-foreground/60">{timeLabel}</span>
      </div>
      {nodes.map((node) =>
        node.kind === "turn" ? (
          renderSegment(node.turn, ctx)
        ) : (
          // Keyed on the first turn's blockId: a burst's identity is where it
          // starts, and that is stable across re-renders in a way an index is
          // not (a burst gained or lost at the top would remap every key).
          <BurstFold key={`burst:${node.turns[0]?.blockId}`} turns={node.turns} ctx={ctx} />
        )
      )}
    </div>
  );
}

// ── Thread (pure, snapshot-in) ──────────────────────────────────────────────────

/**
 * Interleave the rewind markers back into the rendered turn stream.
 *
 * A group is emitted immediately before the first rendered turn at or after its
 * anchor. Groups anchored BEFORE the window are dropped rather than floated to
 * the top: a positional marker's whole claim is "the rewind happened HERE", so
 * showing one detached from its position would reintroduce the defect this
 * replaces. "Show older" brings them back with their surroundings.
 */
export function buildTurnNodes({
  preparedTurns,
  supersededGroups,
  blockIndexById,
  turnIndexByBlockId,
  entityIndex,
  expandSignal,
  address,
  addressedBlockId,
  filmPath,
}: {
  preparedTurns: PreparedTurn[];
  /** Film-tab path enabling the per-row "watch this moment" link (mt#3794). */
  filmPath?: string;
  supersededGroups: SupersededGroup[];
  blockIndexById: Map<string, number>;
  /**
   * Block id → the transcript position the snapshot stamped on it (mt#3791).
   * Distinct from `blockIndexById`, which is a position in the FILTERED block
   * array and is used for marker ordering — an address is not expressed on that
   * scale and the two must not be conflated.
   */
  turnIndexByBlockId: Map<string, number>;
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
  /** The address being served, when one resolved (mt#3791). */
  address?: TurnAddress;
  /** Which block that address resolved to; only that turn gets `address`. */
  addressedBlockId?: string;
}): ReactNode[] {
  const nodes: ReactNode[] = [];
  // With no rendered turn there is no window to be outside OF, so `0` here
  // means "drop nothing" — every anchor is >= 0, the skip loop below is a
  // no-op, and the trailing flush emits every group. Stated explicitly because
  // the value looks like a position and is not one (PR #2449 R1).
  const firstRendered = preparedTurns[0];
  const windowStart =
    firstRendered === undefined ? 0 : (blockIndexById.get(firstRendered.blockId) ?? 0);

  let next = 0;
  while (next < supersededGroups.length && supersededGroups[next]!.anchorIndex < windowStart) {
    next++;
  }

  const pushGroup = (group: SupersededGroup) => {
    nodes.push(<SupersededPromptMarker key={supersededMarkerKey(group)} prompts={group.prompts} />);
  };

  // The open run (mt#3845). Turns accumulate here and are emitted as ONE
  // `RunView` when something ends the run — see `flushRun` callers below.
  let openRun: PreparedTurn[] = [];
  const flushRun = () => {
    if (openRun.length === 0) return;
    const turns = openRun;
    openRun = [];
    nodes.push(
      <RunView
        key={`run-${turns[0]!.blockId}`}
        turns={turns}
        entityIndex={entityIndex}
        expandSignal={expandSignal}
        turnIndexByBlockId={turnIndexByBlockId}
        address={address}
        addressedBlockId={addressedBlockId}
        filmPath={filmPath}
      />
    );
  };

  preparedTurns.forEach((turn, i) => {
    // A turn whose block is not in the index (live-tail races) sorts last
    // rather than swallowing every pending marker.
    const turnIndex = blockIndexById.get(turn.blockId) ?? Number.MAX_SAFE_INTEGER;

    // The day/gap separator goes FIRST, so the marker stays adjacent to the
    // prompt that replaced it. A rewind that straddles a day boundary would
    // otherwise render as marker → "Thu, Jul 30" → prompt, reading as though
    // the marker belonged to the turn before the boundary.
    const separator = turnSeparator(preparedTurns[i - 1]?.timestamp, turn.timestamp);
    if (separator) {
      // Every interleaved node ENDS the open run. A separator or a rewind
      // marker swallowed into a contiguous actor block would read as that
      // actor's output, which is the failure this grouping must not introduce.
      flushRun();
      nodes.push(<TurnSeparatorRow key={`${turn.blockId}-sep`} separator={separator} />);
    }

    while (next < supersededGroups.length && supersededGroups[next]!.anchorIndex <= turnIndex) {
      flushRun();
      pushGroup(supersededGroups[next]!);
      next++;
    }

    // A compaction summary is not a turn the operator wrote — it replaces the
    // body entirely with a labeled boundary, and stands OUTSIDE any run rather
    // than sitting under an actor header that would claim authorship of it.
    if (turn.isCompactSummary) {
      flushRun();
      nodes.push(
        <CompactionBoundary
          key={turn.blockId}
          turn={turn}
          entityIndex={entityIndex}
          expandSignal={expandSignal}
        />
      );
      return;
    }

    const previous = openRun[openRun.length - 1];
    if (previous !== undefined && !sameActor(actorKeyOf(previous), actorKeyOf(turn))) {
      flushRun();
    }
    openRun.push(turn);
  });

  // Before the trailing markers, not after: a rewind with no live block after
  // it belongs BELOW the last rendered run, the same as any other marker.
  flushRun();

  // A rewind with no live block after it — the operator rewound and has not yet
  // sent the replacement.
  while (next < supersededGroups.length) {
    pushGroup(supersededGroups[next]!);
    next++;
  }

  return nodes;
}
