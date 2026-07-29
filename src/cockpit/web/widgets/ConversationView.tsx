/**
 * ConversationView (mt#2374) — readable chat-thread render of a session transcript.
 *
 * A LAYOUT-AGNOSTIC body component (per the mt#2373 widget contract): it takes
 * data + a render context and renders a chronological chat thread — it does NOT
 * assume it lives in a tab vs. a panel vs. a full page. The surrounding chrome
 * is supplied by the host (a WidgetShell variant, a page section, a tab body).
 *
 * Three ways to give it data (mt#2374 success criterion "given a session id or
 * a pre-fetched snapshot"; the third added by mt#2751):
 *   - `{ sessionId }`  — self-fetches the snapshot from the existing
 *                        `/api/cockpit/context-inspector/snapshot` endpoint
 *                        (mt#2023) via TanStack Query.
 *   - `{ snapshot }`   — renders a pre-fetched SessionContextSnapshot directly
 *                        (used by hosts that already hold the snapshot, and by
 *                        the layout-agnostic acceptance test).
 *   - `{ drivenSessionId, drivenBlocks }` — mt#2751 Rung 2B: renders a
 *                        driven-session's live blocks with NO DB snapshot at
 *                        all (a fresh spawn has no prior transcript). The
 *                        caller owns the single `useDrivenSession` WS
 *                        connection (so composer/status siblings can share
 *                        it) and passes its accumulated `blocks` straight
 *                        through — this variant just wraps them in an empty
 *                        base snapshot and feeds `ConversationThread`'s
 *                        EXISTING `extraBlocks` seam, so the two Rung-1 SSE
 *                        live-tail channels above and this driven WS channel
 *                        all share the identical rendering code path.
 *
 * Data comes from `assembleSessionContextSnapshot()` (mt#2022), which preserves
 * each turn's full `message.content` (thinking / tool_use / tool_result). The
 * per-line blocks are expanded into ordered conversational sub-elements by the
 * shared domain parser `snapshotBlocksToConversation` — NOT by a parallel
 * frontend copy, and NOT by reading the raw JSONL (the mt#2021 DB-only
 * invariant holds: the only substrate read is the snapshot endpoint).
 *
 * @see mt#2374 — this component
 * @see packages/domain/src/transcripts/conversation-elements.ts — the shared parser
 * @see mt#2370 — the session-tab frame this will eventually render into
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import {
  snapshotBlocksToConversation,
  type ConversationElement,
  type ConversationRole,
  type ConversationTurn,
} from "@minsky/domain/transcripts/conversation-elements";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";
import type { ConversationId, WorkspaceId } from "@minsky/domain/ids";
import type { EntityIndex } from "../lib/entity-linkifier";
import { useEntityIndex } from "../lib/use-entity-index";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { useLiveTail, useConversationLiveTail } from "../hooks/useLiveTail";
import {
  ElementView,
  isApiErrorText,
  type ExpandSignal,
  type PreparedElement,
  type ToolCallElement,
  type ToolResultElement,
} from "../components/ConversationElementRenderers";
import {
  classifySnapshotError,
  fetchSnapshot,
  snapshotQueryKey,
  snapshotRetry,
} from "../lib/conversation-snapshot";
import {
  splitInjectedContent,
  type InjectedContentKind,
  type InjectedSpan,
} from "../lib/injected-content";
import { formatLocalTime, turnSeparator, type TurnSeparator } from "../lib/conversation-timeline";

// ── Props ─────────────────────────────────────────────────────────────────────

type ConversationViewProps =
  | {
      sessionId: ConversationId;
      snapshot?: undefined;
      className?: string;
      /**
       * Minsky workspace sessionId (WorkspaceId). When provided, `ConversationFetcher`
       * opens the `GET /api/agents/:id/live-tail` SSE channel and appends new turns
       * in real time alongside the DB snapshot. The id-spaces are distinct — this must
       * NOT be the same string as `sessionId` (which is the harness agentSessionId).
       *
       * This is the pluggable live stream-source seam (mt#2232 Rung 1).
       * Mutually exclusive with `liveByConversationId` — when both are set,
       * this workspace-keyed channel takes precedence.
       */
      workspaceSessionId?: WorkspaceId;
      /**
       * Opt in to the conversation-keyed live-tail channel (mt#2749): when
       * `true` (and `workspaceSessionId` is NOT set), `ConversationFetcher`
       * opens `GET /api/conversation/:sessionId/live-tail` directly off
       * `sessionId` — no workspace/cwd bridge required. Used by the
       * conversation surface (`ConversationPage`, keyed by agentSessionId
       * alone) where no workspace context exists at all.
       */
      liveByConversationId?: boolean;
      drivenSessionId?: undefined;
      drivenBlocks?: undefined;
      /**
       * Called once when the snapshot fetch resolves to a genuine "no
       * transcript" 404 (mt#2769) — NOT for `wrong_id_space`, which has its
       * own inline fail-loud surface and is a routing mistake, not an
       * invalid entity. Lets a URL-routed host (e.g. `ConversationPage`)
       * prune its own tab-strip entry for an unresolvable id.
       */
      onNotFound?: () => void;
    }
  | {
      snapshot: SessionContextSnapshot;
      sessionId?: undefined;
      workspaceSessionId?: never;
      liveByConversationId?: never;
      onNotFound?: never;
      className?: string;
      drivenSessionId?: undefined;
      drivenBlocks?: undefined;
    }
  | {
      /**
       * Driven-session id (mt#2751 Rung 2B — the `DrivenSessionRecord.localId`
       * a `useDrivenSession` caller is connected to). Opt-in driven-source
       * variant mirroring `liveByConversationId`'s shape: pass a distinct id +
       * its accumulated blocks rather than a DB-fetched `sessionId`/`snapshot`.
       * Unlike the other two variants, ConversationView does NOT own the data
       * connection here — the caller's own `useDrivenSession(drivenSessionId)`
       * call is the single source of truth (so composer/status UI siblings
       * outside this component can share the same WebSocket), and its
       * `blocks` are passed straight through as `drivenBlocks`.
       */
      drivenSessionId: string;
      /** The `blocks` array from the caller's `useDrivenSession` hook. */
      drivenBlocks: SessionContextSnapshotBlock[];
      sessionId?: undefined;
      snapshot?: undefined;
      workspaceSessionId?: never;
      liveByConversationId?: never;
      className?: string;
    };

// ── Snapshot fetch — shared with ContextBlockView via lib/conversation-snapshot ──
// (mt#2768 "one snapshot query key" success criterion; see that module's docblock)

// ── Entity index for linkification ────────────────────────────────────────────
//
// The known-entity id-set used to linkify bare references (mt#NNNN, UUIDs) is
// now built by the shared `useEntityIndex` hook (../lib/use-entity-index.ts),
// extracted from this file in mt#2550 so every prose surface (`<Prose>`) shares
// one index. ConversationView consumes it via ConversationThread below.

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

// ── Tool-invocation pairing (mt#2790) ───────────────────────────────────────────
//
// A pre-render assembly pass that merges each tool-call with its matching
// tool-result (found via `toolUseId`), so the pair renders as ONE block
// instead of two turn-level blocks (a call under ASSISTANT, a result under
// USER). Pairing is scoped to the turns actually being rendered ("the
// rendered window") — a result whose call fell outside that set (windowing/
// pagination cut it, or mt#2789's subagent-transcript duplication) is an
// ORPHAN and keeps the pre-redesign standalone treatment; it is never
// silently dropped.

// `ToolCallElement` / `ToolResultElement` / `PreparedElement` are imported
// above from `../components/ConversationElementRenderers` (mt#3262 SC 2) —
// the shared module the session-film ribbon's expanded row also builds
// `PreparedElement`s against.

interface PreparedTurn {
  blockId: string;
  role: ConversationRole;
  timestamp: string;
  elements: PreparedElement[];
  isSpawnBoundary: boolean;
  spawnAgentKind?: string;
  /** This turn IS the context-compaction summary (mt#3260). */
  isCompactSummary?: boolean;
  /** The harness, not the operator, generated this turn (mt#3322). */
  isMeta?: boolean;
  /** Assistant model; `<synthetic>` marks a harness retry turn (mt#3260). */
  model?: string;
}

/**
 * Merge tool-calls with their matching tool-results across `turns` (the
 * turns actually being rendered — see module docblock). `callNameByToolUseId`
 * is built over the FULL, unwindowed transcript (unchanged pre-existing
 * behavior) so an orphan can still show which tool it answers even when that
 * tool's call turn isn't in the current set.
 */
function pairToolInvocations(
  turns: ConversationTurn[],
  callNameByToolUseId: Map<string, string>
): PreparedTurn[] {
  const callById = new Map<string, ToolCallElement>();
  const resultById = new Map<string, ToolResultElement>();
  for (const turn of turns) {
    for (const el of turn.elements) {
      if (el.kind === "tool-call" && el.id) callById.set(el.id, el);
      if (el.kind === "tool-result" && el.toolUseId) resultById.set(el.toolUseId, el);
    }
  }

  return turns.map((turn) => {
    const elements: PreparedElement[] = [];

    // Injected-content detection is scoped to USER turns (mt#2791) — command
    // wrappers, skill-body preambles, and system reminders are ALWAYS
    // harness-injected into a user turn, never assistant-authored, so
    // scoping here (rather than substring-matching everywhere) keeps
    // detection conservative per the module's anchored-pattern design.
    // Non-user turns keep the pre-mt#2791 pass-through, unchanged below.
    if (turn.role !== "user") {
      for (const el of turn.elements) {
        switch (el.kind) {
          case "tool-call": {
            const result = el.id ? resultById.get(el.id) : undefined;
            elements.push({ kind: "tool-invocation", call: el, result });
            break;
          }
          case "tool-result": {
            const pairedInWindow = el.toolUseId ? callById.has(el.toolUseId) : false;
            if (pairedInWindow) break;
            elements.push({
              kind: "tool-result-orphan",
              result: el,
              callName: el.toolUseId ? callNameByToolUseId.get(el.toolUseId) : undefined,
            });
            break;
          }
          default:
            elements.push(el);
        }
      }
    } else {
      // Consecutive `text` elements are concatenated into one run BEFORE
      // injected-content detection (mt#2791). The harness sometimes splits
      // one logical injection across adjacent text sub-blocks in a turn's
      // message content array — e.g. a skill invocation arrives as TWO
      // parts: `<command-message>…</command-message><command-name>…</command-name>
      // <skill-format>true</skill-format>` as one block, then
      // "Base directory for this skill: <path>\n\n<body>" as the next
      // (verified against a live transcript). Splitting each part in
      // isolation misses the cross-element join: the first part fails the
      // skill-body pattern (no "Base directory..." follows it WITHIN that
      // block) and falls back to a bare "command:" match, leaking the raw
      // `<skill-format>` tag as literal prose between two mis-split blocks.
      // Concatenating the run first reconstructs the single contiguous
      // string the harness effectively injected, so the pair renders as ONE
      // correctly-labeled "skill body: <name>" block.
      let textRun = "";
      let hasTextRun = false;
      const flushTextRun = () => {
        if (!hasTextRun) return;
        for (const seg of splitInjectedContent(textRun)) {
          if (seg.type === "injected") {
            elements.push({ kind: "injected", span: seg.span });
          } else if (seg.text.trim().length > 0) {
            // A mixed turn splits: only the injected span collapses, the
            // genuine prose renders exactly as it would have unsplit.
            elements.push({ kind: "text", text: seg.text });
          }
        }
        textRun = "";
        hasTextRun = false;
      };

      for (const el of turn.elements) {
        switch (el.kind) {
          case "text":
            textRun += el.text;
            hasTextRun = true;
            break;
          case "tool-call": {
            flushTextRun();
            const result = el.id ? resultById.get(el.id) : undefined;
            elements.push({ kind: "tool-invocation", call: el, result });
            break;
          }
          case "tool-result": {
            flushTextRun();
            const pairedInWindow = el.toolUseId ? callById.has(el.toolUseId) : false;
            if (pairedInWindow) break;
            elements.push({
              kind: "tool-result-orphan",
              result: el,
              callName: el.toolUseId ? callNameByToolUseId.get(el.toolUseId) : undefined,
            });
            break;
          }
          default:
            flushTextRun();
            elements.push(el);
        }
      }
      flushTextRun();
    }

    return {
      blockId: turn.blockId,
      role: turn.role,
      timestamp: turn.timestamp,
      elements,
      isSpawnBoundary: turn.isSpawnBoundary,
      spawnAgentKind: turn.spawnAgentKind,
      isCompactSummary: turn.isCompactSummary,
      isMeta: turn.isMeta,
      model: turn.model,
    };
  });
}

// ── Command-invocation merging (mt#3322) ────────────────────────────────────
//
// The harness emits ONE slash command as up to three consecutive user turns:
// a model-directed caveat (`isMeta: true`), the command wrapper, and the
// captured stdout. Rendered turn-by-turn that is three USER bubbles of raw
// harness plumbing above the operator's actual message.
//
// This pass is the command analogue of `pairToolInvocations` above: it folds
// the output and caveat INTO the command element, then leaves the drained
// turns with no renderable elements so the existing
// `hasRenderablePreparedElement` filter drops them. Nothing is discarded —
// the wrapper markup and the caveat both remain reachable behind the command
// element's disclosure toggle.
//
// Scoped to the rendered window like its sibling: a command whose output turn
// fell outside the window simply renders without output, and an orphaned
// output turn keeps its standalone collapsed treatment rather than vanishing.

/** How far ahead of a command turn to look for its output/caveat turns. */
const COMMAND_PART_LOOKAHEAD = 3;

function soleInjectedSpan(turn: PreparedTurn, kind: InjectedContentKind): InjectedSpan | null {
  if (turn.role !== "user" || turn.elements.length !== 1) return null;
  const [only] = turn.elements;
  if (!only || only.kind !== "injected" || only.span.kind !== kind) return null;
  return only.span;
}

function mergeCommandInvocations(turns: PreparedTurn[]): PreparedTurn[] {
  // Elements are removed from their origin turns as they are absorbed; a copy
  // per turn keeps this pass non-mutating with respect to its input.
  const working = turns.map((t) => ({ ...t, elements: [...t.elements] }));

  for (let i = 0; i < working.length; i++) {
    const turn = working[i];
    if (!turn || turn.role !== "user") continue;

    const commandIndex = turn.elements.findIndex(
      (el) => el.kind === "injected" && el.span.kind === "command"
    );
    if (commandIndex === -1) continue;
    const commandElement = turn.elements[commandIndex];
    if (!commandElement || commandElement.kind !== "injected") continue;

    let output: InjectedSpan | undefined;
    let caveat: InjectedSpan | undefined;

    // The caveat precedes the command in file order; the output follows it.
    // Both are single-element turns, which is what makes absorbing them safe:
    // a turn carrying anything else keeps its own rendering.
    for (let j = Math.max(0, i - COMMAND_PART_LOOKAHEAD); j < i; j++) {
      const candidate = working[j];
      if (!candidate) continue;
      const span = soleInjectedSpan(candidate, "local-command-caveat");
      if (!span) continue;
      caveat = span;
      candidate.elements = [];
    }
    for (let j = i + 1; j <= i + COMMAND_PART_LOOKAHEAD && j < working.length; j++) {
      const candidate = working[j];
      if (!candidate) continue;
      const span = soleInjectedSpan(candidate, "local-command-output");
      if (!span) continue;
      output = span;
      candidate.elements = [];
      break;
    }

    turn.elements[commandIndex] = {
      kind: "command-invocation",
      command: commandElement.span,
      ...(output ? { output } : {}),
      ...(caveat ? { caveat } : {}),
    };
  }

  return working;
}

function hasRenderablePreparedElement(el: PreparedElement): boolean {
  switch (el.kind) {
    case "text":
      return el.text.trim().length > 0;
    case "thinking":
      return el.thinking.trim().length > 0;
    // "injected" / "tool-invocation" / "tool-result-orphan" / "unknown" all
    // fall to the default: always renderable (mirrors pre-mt#2791 behavior).
    default:
      return true;
  }
}

// `isApiErrorText` is imported above from `../components/
// ConversationElementRenderers` (mt#3262 SC 2) — `turnOutcome` below and the
// shared `ElementView`'s text-case both need the SAME detection.

/**
 * The per-turn Outcome chip's value, or `null` when none is evidenced.
 *
 * mt#3130's Outcome register has six values (`Completed` · `Interrupted` ·
 * `Errored` · `Rate-limited` · `Crashed` · `Stalled`). Two are evidenced by the
 * transcript as parsed today:
 *
 *  - **`Interrupted`** — a tool-result carrying `isInterruptionRejection`
 *    (`conversation-elements.ts`), i.e. the operator cancelled a pending tool
 *    call. mt#3260.
 *  - **`Errored`** — assistant text starting with the API-error prefix.
 *
 * The rest need signals that do not exist in the persisted transcript
 * (`Completed` has no terminator field; `Rate-limited`/`Crashed`/`Stalled` are
 * run-state, not transcript, facts).
 *
 * So an unremarkable turn returns `null` rather than `Completed` — deliberate,
 * not a stub. Labeling a turn `Completed` without a completion signal would
 * assert completion for turns that were actually cut off. An absent chip says
 * "nothing to report"; a wrong `Completed` chip is the falsely-confident
 * derived field this umbrella exists to remove.
 */
type TurnOutcome = "Interrupted" | "Errored";

function elementIsInterruption(element: PreparedElement): boolean {
  if (element.kind === "tool-invocation") return element.result?.isInterruptionRejection === true;
  if (element.kind === "tool-result-orphan") return element.result.isInterruptionRejection === true;
  return false;
}

function turnOutcome(turn: PreparedTurn): TurnOutcome | null {
  if (turn.role !== "assistant") return null;
  let errored = false;
  for (const element of turn.elements) {
    // Interruption WINS over error, and the precedence is load-bearing: the
    // harness marks a cancelled tool call `isError`, but the operator
    // cancelling is not a failure. Reporting it as `Errored` is exactly the
    // miscount mt#3131 removed from the tallies — this keeps the RENDER
    // consistent with those already-corrected counts.
    if (elementIsInterruption(element)) return "Interrupted";
    if (element.kind === "text" && isApiErrorText(element.text)) errored = true;
  }
  return errored ? "Errored" : null;
}

/**
 * `Interrupted` is amber, never red — `docs/design-system.md`'s red-scarcity
 * rule reserves the destructive tone for genuine failures, and mt#3130 calls
 * out this exact distinction ("amber, NOT red — distinct from error").
 */
const OUTCOME_STYLES: Record<TurnOutcome, string> = {
  Interrupted: "bg-warn-amber/15 text-warn-amber",
  Errored: "bg-destructive/15 text-destructive",
};

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

function TurnView({
  turn,
  entityIndex,
  expandSignal,
}: {
  turn: PreparedTurn;
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
}) {
  const roleStyle = ROLE_STYLES[turn.role];
  const outcome = turnOutcome(turn);
  const isRetry = turn.model === SYNTHETIC_MODEL;

  // A compaction summary is not a turn the operator wrote — it replaces the
  // body entirely with a labeled boundary rather than rendering as prose.
  if (turn.isCompactSummary) {
    return (
      <CompactionBoundary turn={turn} entityIndex={entityIndex} expandSignal={expandSignal} />
    );
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
        />
      );
      return node;
    })
    .filter(Boolean);

  // A turn with no renderable elements (e.g. an empty pairing) is skipped by the caller.
  return (
    <div className={cn("flex flex-col gap-2 border-l-2 pl-3", roleStyle.accent)}>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span className="font-semibold">{roleStyle.label}</span>
        {turn.isSpawnBoundary && (
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium normal-case text-violet-300">
            → subagent{turn.spawnAgentKind ? ` (${turn.spawnAgentKind})` : ""}
          </span>
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
              OUTCOME_STYLES[outcome]
            )}
            data-testid="turn-outcome"
          >
            {outcome}
          </span>
        )}
        <span className="ml-auto tabular-nums text-muted-foreground/60">
          {formatTime(turn.timestamp)}
        </span>
      </div>
      <div className="flex flex-col gap-2">{rendered}</div>
    </div>
  );
}

// ── Thread (pure, snapshot-in) ──────────────────────────────────────────────────

/**
 * Tail-first window (mt#2433): the measured cost on long sessions is the eager
 * MOUNT of every formatted block (265 blocks / ~1MB took >20s to first content;
 * the snapshot fetch itself is ~1s), so only the most recent INITIAL_TURNS
 * turns render on mount — the chat idiom: the operator cares about the newest
 * exchange. "Show older" reveals earlier turns in OLDER_CHUNK increments.
 */
const INITIAL_TURNS = 50;
const OLDER_CHUNK = 100;

/**
 * A day boundary or a long-gap marker between two turns. Renders as a quiet
 * rule with a centered label — it is orientation, not content, so it must not
 * compete with the turns on either side.
 */
function TurnSeparatorRow({ separator }: { separator: TurnSeparator }) {
  const isDay = separator.kind === "day";
  return (
    <div
      className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground/70"
      data-testid={isDay ? "turn-day-divider" : "turn-gap-divider"}
    >
      <span className="h-px flex-1 bg-border" />
      <span className={cn("tabular-nums", isDay && "font-medium text-muted-foreground")}>
        {isDay ? separator.label : `${separator.label} gap`}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function ConversationThread({
  snapshot,
  extraBlocks,
  className,
}: {
  snapshot: SessionContextSnapshot;
  /**
   * Live-tail blocks to append after the snapshot's historical blocks (mt#2232).
   * When non-empty, they are merged into the block list before turn conversion.
   * Block ids in `extraBlocks` must NOT collide with snapshot block ids — live
   * blocks use the `<agentSessionId>:live:<N>` scheme to guarantee this.
   */
  extraBlocks?: SessionContextSnapshotBlock[];
  className?: string;
}) {
  // Build the entity index for transcript linkification. Fetches the same
  // underlying data as CommandPalette via useEntityIndex (which uses distinct
  // query keys to avoid cache-shape collisions — see useEntityIndex for details).
  const entityIndex = useEntityIndex();

  // Merge snapshot blocks with any live-tail appends.
  const allBlocks = useMemo(
    () =>
      extraBlocks && extraBlocks.length > 0
        ? [...snapshot.blocks, ...extraBlocks]
        : snapshot.blocks,
    [snapshot.blocks, extraBlocks]
  );

  const turns = useMemo(() => snapshotBlocksToConversation(allBlocks), [allBlocks]);

  // Map every tool_use id → tool name so a tool-result can name the call it answers.
  // Computed over ALL turns (not the window): a windowed tool-result may answer
  // a call that is currently outside the window.
  const callNameByToolUseId = useMemo(() => {
    const map = new Map<string, string>();
    for (const turn of turns) {
      for (const el of turn.elements) {
        if (el.kind === "tool-call" && el.id) map.set(el.id, el.name);
      }
    }
    return map;
  }, [turns]);

  // Drop turns with nothing renderable (e.g. empty user pairings).
  const visibleTurns = useMemo(
    () =>
      turns.filter((t) =>
        t.elements.some((e) =>
          e.kind === "text"
            ? e.text.trim().length > 0
            : e.kind === "thinking"
              ? e.thinking.trim().length > 0
              : true
        )
      ),
    [turns]
  );

  const [visibleCount, setVisibleCount] = useState(INITIAL_TURNS);
  // Persistent "Show all" mode: once chosen it tracks transcript GROWTH too —
  // a fixed count would silently re-clip the oldest turns (and resurface the
  // control) when a refetch adds turns to the same session (PR #1667 R1).
  const [showAll, setShowAll] = useState(false);

  // One-shot gate for the initial scroll-to-newest. Declared before the
  // session-change effect below, which re-arms it.
  const didInitialScrollRef = useRef(false);

  // New session in the same mounted component → window back to the tail.
  useEffect(() => {
    setVisibleCount(INITIAL_TURNS);
    setShowAll(false);
    // Each session load lands on the tail — including in-place session swaps
    // (same mounted component, new agentSessionId), so the one-shot scroll
    // gate re-arms here (PR #1667 R2 non-blocking).
    didInitialScrollRef.current = false;
  }, [snapshot.agentSessionId]);

  const effectiveCount = showAll ? visibleTurns.length : visibleCount;
  const windowedTurns = useMemo(
    () => visibleTurns.slice(Math.max(0, visibleTurns.length - effectiveCount)),
    [visibleTurns, effectiveCount]
  );
  const hiddenCount = visibleTurns.length - windowedTurns.length;

  // Merge call+result pairs within the rendered window (mt#2790), then drop
  // any turn that has nothing left to render (a pure-tool-result USER turn
  // whose result got merged into its call's block above).
  const preparedTurns = useMemo(
    () =>
      mergeCommandInvocations(pairToolInvocations(windowedTurns, callNameByToolUseId)).filter((t) =>
        t.elements.some(hasRenderablePreparedElement)
      ),
    [windowedTurns, callNameByToolUseId]
  );

  // View-level expand-all / collapse-all broadcast (mt#2790): each click bumps
  // `epoch` so every mounted ToolInvocation re-syncs its local `open` state.
  const [expandSignal, setExpandSignal] = useState<ExpandSignal>(undefined);

  // Land on the newest exchange once, after the windowed items are actually in
  // the DOM (layout effect keyed on the mounted count — an empty first commit
  // must not consume the one-shot; PR #1667 R1). Expanding "Show older" later
  // must not yank the scroll position, hence the one-shot flag.
  const endRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (didInitialScrollRef.current) return;
    if (preparedTurns.length === 0) return;
    didInitialScrollRef.current = true;
    if (hiddenCount > 0) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [preparedTurns.length, hiddenCount]);

  // Live-tail auto-scroll: when new turns arrive from the SSE stream (mt#2232),
  // scroll to the bottom so the operator sees them immediately. Only fires
  // when extraBlocks grows — not on the initial snapshot render (which has the
  // one-shot gate above). Keyed on extraBlocks.length so it fires once per new
  // live turn, not on every render.
  const extraBlocksLen = extraBlocks?.length ?? 0;
  useLayoutEffect(() => {
    if (extraBlocksLen === 0) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [extraBlocksLen]);

  if (visibleTurns.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        This session has no conversational turns to display.
      </p>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-center justify-end gap-3 text-[11px] text-muted-foreground/70">
        <button
          type="button"
          onClick={() => setExpandSignal((s) => ({ epoch: (s?.epoch ?? 0) + 1, open: true }))}
          className="transition-colors hover:text-foreground hover:underline"
        >
          Expand all
        </button>
        <button
          type="button"
          onClick={() => setExpandSignal((s) => ({ epoch: (s?.epoch ?? 0) + 1, open: false }))}
          className="transition-colors hover:text-foreground hover:underline"
        >
          Collapse all
        </button>
      </div>
      {hiddenCount > 0 && !showAll && (
        <div className="flex items-center justify-center gap-3 py-1">
          <button
            type="button"
            onClick={() => setVisibleCount((c) => c + OLDER_CHUNK)}
            className="rounded border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
          >
            Show older ({hiddenCount} more)
          </button>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-xs text-muted-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Show all
          </button>
        </div>
      )}
      {preparedTurns.flatMap((turn, i) => {
        const separator = turnSeparator(preparedTurns[i - 1]?.timestamp, turn.timestamp);
        const nodes: ReactNode[] = [];
        if (separator) {
          nodes.push(<TurnSeparatorRow key={`${turn.blockId}-sep`} separator={separator} />);
        }
        nodes.push(
          <TurnView
            key={turn.blockId}
            turn={turn}
            entityIndex={entityIndex}
            expandSignal={expandSignal}
          />
        );
        return nodes;
      })}
      <div ref={endRef} aria-hidden />
    </div>
  );
}

// ── Driven-session wrapper (mt#2751 Rung 2B) ────────────────────────────────────

/** Stable empty-array reference — avoids recreating a fresh `[]` (and therefore
 * invalidating `ConversationThread`'s internal `useMemo`) on every render. */
const EMPTY_DRIVEN_BASE_BLOCKS: SessionContextSnapshotBlock[] = [];
/** Fixed placeholder — never read by any renderer; only present because
 * `SessionContextSnapshot.assembledAt` is required by the type. */
const DRIVEN_BASE_ASSEMBLED_AT = new Date(0).toISOString();

/**
 * Wraps a driven session's live-accumulated `drivenBlocks` in an empty base
 * snapshot and feeds them through `ConversationThread`'s `extraBlocks` seam —
 * the SAME renderer `ConversationFetcher` uses for the two SSE live-tail
 * channels above. Verifies mt#2751 success criterion 2 ("the display
 * component is shared with Rung 1... verified by shared code path").
 */
function DrivenSessionThread({
  drivenSessionId,
  drivenBlocks,
  className,
}: {
  drivenSessionId: string;
  drivenBlocks: SessionContextSnapshotBlock[];
  className?: string;
}) {
  const baseSnapshot = useMemo<SessionContextSnapshot>(
    () => ({
      agentSessionId: drivenSessionId,
      // `claude_code` is correct-by-construction here, not a placeholder: the
      // driven-session host (mt#2750) only ever spawns the genuine `claude`
      // binary, so a driven session IS a Claude Code harness session. If the
      // host ever drives a second harness, thread the harness through from the
      // driven-session record instead (mt#2751 R1 note).
      harness: "claude_code",
      blocks: EMPTY_DRIVEN_BASE_BLOCKS,
      assembledAt: DRIVEN_BASE_ASSEMBLED_AT,
    }),
    [drivenSessionId]
  );
  return (
    <ConversationThread
      snapshot={baseSnapshot}
      extraBlocks={drivenBlocks.length > 0 ? drivenBlocks : undefined}
      className={className}
    />
  );
}

// ── Self-fetching wrapper ───────────────────────────────────────────────────────

function ConversationFetcher({
  sessionId,
  workspaceSessionId,
  liveByConversationId,
  onNotFound,
  className,
}: {
  sessionId: ConversationId;
  /**
   * When provided, opens a live-tail SSE connection and appends new turns to
   * the static snapshot in real-time (mt#2232 Rung 1). Must be the Minsky
   * workspace sessionId (WorkspaceId) — NOT the same string as `sessionId`.
   */
  workspaceSessionId?: WorkspaceId;
  /**
   * When `true` (and `workspaceSessionId` is NOT set), opens the
   * conversation-keyed live-tail channel directly off `sessionId` (mt#2749).
   */
  liveByConversationId?: boolean;
  /** See `ConversationViewProps` — fires on a genuine 404, not on wrong_id_space. */
  onNotFound?: () => void;
  className?: string;
}) {
  const query = useQuery<SessionContextSnapshot, Error>({
    queryKey: snapshotQueryKey(sessionId),
    queryFn: () => fetchSnapshot(sessionId),
    staleTime: 30_000,
    retry: snapshotRetry,
  });

  // Live-tail seam: exactly one of the two channels is active per host —
  // workspaceSessionId (mt#2232, WorkspaceDetailPage) takes precedence when
  // both happen to be set; liveByConversationId (mt#2749, ConversationPage)
  // opens the conversation-keyed channel with no workspace bridge. Both hooks
  // are always called (rules-of-hooks) — each is a no-op when its id arg is
  // falsy, so only the selected channel actually connects.
  const workspaceLive = useLiveTail(workspaceSessionId);
  const conversationLive = useConversationLiveTail(
    liveByConversationId && !workspaceSessionId ? sessionId : undefined
  );
  const liveBlocks = workspaceSessionId ? workspaceLive.liveBlocks : conversationLive.liveBlocks;

  // mt#3131 (PR #2245 R1): all error-code/status interpretation is centralized
  // in `classifySnapshotError` (lib/conversation-snapshot.ts) next to the
  // `SnapshotError` type it classifies — this component never keys on raw
  // `code === "..."` strings or bare status numbers, so a server-side contract
  // drift has exactly one client site to update.
  const errClass = query.isError ? classifySnapshotError(query.error) : null;
  const wrongIdSpace = errClass === "wrong_id_space";
  // mt#3131 (D3/D5): the server rejects a syntactically-invalid id (not even
  // UUID-shaped) BEFORE any DB lookup, so it can never mean "still running" —
  // distinguish it from a genuine "no transcript yet" so the copy below never
  // tells the reader an impossible id "may still be running".
  const invalidId = errClass === "invalid_id";
  const notFound = errClass === "not_found";

  // Report a genuine unresolvable id to the host (mt#2769) — e.g. so a
  // URL-routed page can prune its own tab-strip entry. NOT fired for
  // wrong_id_space: that's a routing mistake (a valid workspace id used on
  // the wrong route), not an invalid entity. `invalidId` (mt#3131 D3/D5) is
  // the strongest case of "genuinely unresolvable" — it fires too.
  useEffect(() => {
    if (notFound || invalidId) onNotFound?.();
  }, [notFound, invalidId, onNotFound]);

  if (query.isError) {
    // Fail LOUD on the wrong-id-space mistake (mt#2525 / mt#2420): a workspace
    // session id was passed where a harness conversation id is required. This
    // must NOT fall through to the "no transcript yet" empty state — that was
    // the original misleading surface. Also key off the 422 status so an
    // intermediary/proxy that drops the JSON body but preserves the status still
    // routes here (reviewer #1729 robustness suggestion).
    if (wrongIdSpace) {
      return (
        <div
          role="alert"
          className={cn("flex flex-col items-center gap-1 py-10 text-center", className)}
        >
          <p className="text-sm font-medium text-destructive">
            Wrong id type for the conversation view.
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            This looks like a Minsky workspace session id, not a harness conversation id.{" "}
            <Link to={`/agents/${encodeURIComponent(sessionId)}`} className="underline">
              Open its workspace detail page
            </Link>{" "}
            and use its &ldquo;View conversation&rdquo; link to reach the transcript.
          </p>
        </div>
      );
    }
    // mt#3131 (D5): a syntactically-invalid id is definitively NOT FOUND —
    // it could never have resolved, so the copy must not suggest it "may
    // still be running" (that framing only makes sense for a plausible id
    // whose transcript simply hasn't landed yet).
    if (invalidId) {
      return (
        <div className={cn("flex flex-col items-center gap-1 py-10 text-center", className)}>
          <p className="text-sm text-muted-foreground">Conversation not found.</p>
          <p className="max-w-md text-xs text-muted-foreground/70">
            &ldquo;{sessionId}&rdquo; is not a valid conversation id.
          </p>
        </div>
      );
    }
    if (notFound) {
      return (
        <div className={cn("flex flex-col items-center gap-1 py-10 text-center", className)}>
          <p className="text-sm text-muted-foreground">
            No conversation transcript for this session yet.
          </p>
          <p className="max-w-md text-xs text-muted-foreground/70">
            Transcripts are ingested when a Claude Code session ends; this one may still be running,
            or its transcript was never ingested.
          </p>
        </div>
      );
    }
    return (
      <ErrorState prefix="Failed to load conversation" error={query.error} className={className} />
    );
  }
  if (query.isLoading || !query.data) {
    return <LoadingState message="Loading conversation…" className={className} />;
  }
  return (
    <ConversationThread
      snapshot={query.data}
      extraBlocks={liveBlocks.length > 0 ? liveBlocks : undefined}
      className={className}
    />
  );
}

// ── Public component ────────────────────────────────────────────────────────────

/**
 * Renders a session's conversation as a chronological chat thread. Layout-agnostic:
 * the host supplies the chrome. Pass `sessionId` (self-fetch), `snapshot`
 * (pre-fetched), or `drivenSessionId`+`drivenBlocks` (mt#2751 live-only, no DB
 * snapshot).
 *
 * Two mutually-exclusive live-tail seams (both bridge a DB-fetched snapshot with
 * a live SSE append):
 *   - `workspaceSessionId` (mt#2232 Rung 1) — real-time appends bridged through
 *     a Minsky workspace. `sessionId` is the harness ConversationId;
 *     `workspaceSessionId` is the distinct Minsky workspace WorkspaceId.
 *   - `liveByConversationId` (mt#2749) — real-time appends opened directly off
 *     `sessionId` alone, no workspace bridge. Used on the conversation surface
 *     (`ConversationPage`), which has no workspace context at all.
 *
 * A third, fully-live seam needs no DB snapshot at all:
 *   - `drivenSessionId` + `drivenBlocks` (mt#2751 Rung 2B) — a driven session
 *     the caller is connected to via its own `useDrivenSession` hook; see
 *     `DrivenSessionThread` above.
 */
export function ConversationView(props: ConversationViewProps) {
  if (props.snapshot !== undefined) {
    return <ConversationThread snapshot={props.snapshot} className={props.className} />;
  }
  if (props.drivenSessionId !== undefined) {
    return (
      <DrivenSessionThread
        drivenSessionId={props.drivenSessionId}
        drivenBlocks={props.drivenBlocks}
        className={props.className}
      />
    );
  }
  return (
    <ConversationFetcher
      sessionId={props.sessionId}
      workspaceSessionId={props.workspaceSessionId}
      liveByConversationId={props.liveByConversationId}
      onNotFound={props.onNotFound}
      className={props.className}
    />
  );
}
