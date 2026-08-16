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
import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import type { ConversationTurn } from "@minsky/domain/transcripts/conversation-elements";
import type { EntityIndex } from "../lib/entity-linkifier";
import {
  ElementView,
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
  type TurnAddress,
} from "../lib/conversation-turn-address";
import { FilmMomentLink } from "./FilmMomentLink";
import type { PreparedTurn } from "../lib/conversation-turn-assembly";
import { formatLocalTime, turnSeparator } from "../lib/conversation-timeline";
import { TurnSeparatorRow } from "./ThreadOrientation";
import { classifyTurnOrigin } from "../lib/turn-origin";

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
 * terminal-condition taxonomy shared with the actuator channel's status
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

/**
 * The model value Claude Code records on a harness-generated retry turn rather
 * than a real model response (mt#3260). Mirrors `SYNTHETIC_MODEL_SENTINEL` in
 * `packages/domain/src/subagent/transcript-metrics.ts`; declared here because
 * that module is subagent-metrics code, not a render dependency.
 */
const SYNTHETIC_MODEL = "<synthetic>";

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

export function TurnView({
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
  const roleStyle = ROLE_STYLES[turn.role];
  // A `user`-role turn may be the operator's message OR harness plumbing the
  // harness injected under that role (skill body, command wrapper, tool
  // result). Label it by who actually wrote it (mt#3374); a null origin means
  // no signal, so the role-derived styling stands.
  const origin = classifyTurnOrigin(turn);
  const label = origin?.kind === "harness" ? origin.label : roleStyle.label;
  const accent = origin?.kind === "harness" ? HARNESS_ACCENT : roleStyle.accent;
  const outcome = turnOutcome(turn);
  const isRetry = turn.model === SYNTHETIC_MODEL;

  // A compaction summary is not a turn the operator wrote — it replaces the
  // body entirely with a labeled boundary rather than rendering as prose.
  if (turn.isCompactSummary) {
    return <CompactionBoundary turn={turn} entityIndex={entityIndex} expandSignal={expandSignal} />;
  }

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
      className={cn(
        // NAMED group (mt#3794): a tool call inside this turn has its own
        // hover-revealed film link, and an unnamed `group` would make hovering
        // anywhere in the turn reveal every call's link at once.
        "group/turn flex flex-col gap-2 border-l-2 pl-3",
        accent,
        marked && ADDRESSED_MARK_CLASS,
        // Keeps the landing clear of the sticky header a scroll-into-view would
        // otherwise tuck the turn under (the same reason the tail sentinel
        // carries `scroll-mb-8`, mt#3344).
        "scroll-mt-16"
      )}
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span className="font-semibold" data-testid="turn-role-label">
          {label}
        </span>
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
        <span className="ml-auto tabular-nums text-muted-foreground/60">
          {formatTime(turn.timestamp)}
        </span>
        {/*
          Turn-grain film link (mt#3794). Gated on a KNOWN `turnIndex`: a
          live-tail block the snapshot never stamped has no address, so there is
          no moment to link to — the same condition that makes it unaddressable
          from the film's side.
        */}
        {filmPath !== undefined && turnIndex !== undefined && (
          <FilmMomentLink
            address={{ turnIndex }}
            filmPath={filmPath}
            className="group-hover/turn:opacity-100"
          />
        )}
      </div>
      <div className="flex flex-col gap-2">{rendered}</div>
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
      nodes.push(<TurnSeparatorRow key={`${turn.blockId}-sep`} separator={separator} />);
    }

    while (next < supersededGroups.length && supersededGroups[next]!.anchorIndex <= turnIndex) {
      pushGroup(supersededGroups[next]!);
      next++;
    }
    nodes.push(
      <TurnView
        key={turn.blockId}
        turn={turn}
        entityIndex={entityIndex}
        expandSignal={expandSignal}
        turnIndex={turnIndexByBlockId.get(turn.blockId)}
        address={turn.blockId === addressedBlockId ? address : undefined}
        filmPath={filmPath}
      />
    );
  });

  // A rewind with no live block after it — the operator rewound and has not yet
  // sent the replacement.
  while (next < supersededGroups.length) {
    pushGroup(supersededGroups[next]!);
    next++;
  }

  return nodes;
}
