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
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  useCallback,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import {
  snapshotBlocksToConversation,
  type ConversationElement,
  type ConversationRole,
  type ConversationTurn,
} from "@minsky/domain/transcripts/conversation-elements";
import { isOperatorPrompt } from "@minsky/domain/transcripts/rewind-detection";
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
  SpawnBadge,
  type ExpandSignal,
  type PreparedElement,
  type ToolCallElement,
  type ToolResultElement,
} from "../components/ConversationElementRenderers";
import { SpawnParentBacklink } from "../components/SpawnParentBacklink";
import {
  SupersededPromptMarker,
  supersededMarkerKey,
  supersededPromptText,
  type SupersededGroup,
  type SupersededPrompt,
} from "../components/SupersededPromptMarker";
import {
  classifyOutcome,
  OUTCOME_TONE,
  type ConversationOutcome,
} from "../lib/conversation-outcome";
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
import { findScrollParent, hasGrown, isNearTop, isPinnedToBottom } from "../lib/scroll-pinning";
import { INITIAL_TURNS, useThreadWindow } from "../hooks/useThreadWindow";
import {
  ThreadPositionPill,
  ThreadStartBoundary,
  TurnSeparatorRow,
} from "../components/ThreadOrientation";
import { classifyTurnOrigin } from "../lib/turn-origin";

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
  /** Child conversation for the turn-level badge — the turn's FIRST spawn (mt#3692). */
  spawnChildAgentSessionId?: string;
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
      spawnChildAgentSessionId: turn.spawnChildAgentSessionId,
      isCompactSummary: turn.isCompactSummary,
      isMeta: turn.isMeta,
      model: turn.model,
    };
  });
}

// ── Command-invocation merging (mt#3322) ────────────────────────────────────
//
// The harness emits ONE slash command as up to three user turns: the command
// wrapper, the captured stdout, and a model-directed caveat (`isMeta: true`).
// Rendered turn-by-turn that is three USER bubbles of raw harness plumbing
// above the operator's actual message.
//
// This pass is the command analogue of `pairToolInvocations` above: it folds
// the output and caveat INTO the command element, then leaves the drained
// turns with no renderable elements so the existing
// `hasRenderablePreparedElement` filter drops them. Nothing is discarded —
// the wrapper markup and the caveat both remain reachable behind the command
// element's disclosure toggle.
//
// **The parts FOLLOW their command, and the scan stops at the first turn that
// is not one of them.** Turns render in TIMESTAMP order, not JSONL file order
// — in conversation 77c6ca4f the caveat is the first line in the file but
// carries the latest timestamp (.486 vs the command's and stdout's .481), so
// the rendered group is command -> stdout -> caveat. Two hard boundaries keep
// the association unambiguous when several commands run in quick succession
// (PR #2403 R1): the scan stops at the NEXT command wrapper, which owns
// everything after it, and at any turn that is not an absorbable part, since
// the group is contiguous. Without those, a `/model` followed closely by
// `/error-handling` could silently cross-wire one command's output onto the
// other and drain the wrong turn.
//
// Scoped to the rendered window like its sibling: a command whose output turn
// fell outside the window simply renders without output, and an orphaned
// output turn keeps its standalone collapsed treatment rather than vanishing.

/**
 * How far past a command turn to look for its parts. An invocation
 * contributes at most two (stdout + caveat); the extra slot is slack for an
 * unexpected additional part, and the boundary checks below — not this
 * number — are what prevent mis-association.
 */
const COMMAND_PART_LOOKAHEAD = 3;

/** The injected-span kinds a command turn may absorb, in no particular order. */
const ABSORBABLE_PART_KINDS = ["local-command-output", "local-command-caveat"] as const;

/** Index of the `command` injected element in a user turn, or -1. */
function commandElementIndex(turn: PreparedTurn): number {
  if (turn.role !== "user") return -1;
  return turn.elements.findIndex((el) => el.kind === "injected" && el.span.kind === "command");
}

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
    if (!turn) continue;

    const commandIndex = commandElementIndex(turn);
    if (commandIndex === -1) continue;
    const commandElement = turn.elements[commandIndex];
    if (!commandElement || commandElement.kind !== "injected") continue;

    const absorbed = new Map<InjectedContentKind, InjectedSpan>();

    // Forward-only, with two hard stops (see the section comment above):
    // the next command wrapper, and any turn that is not an absorbable part.
    // Absorbing is further restricted to SINGLE-element turns — a turn
    // carrying anything else keeps its own rendering rather than being
    // silently drained.
    for (let j = i + 1; j <= i + COMMAND_PART_LOOKAHEAD && j < working.length; j++) {
      const candidate = working[j];
      if (!candidate) break;
      // The next command owns everything from here on.
      if (commandElementIndex(candidate) !== -1) break;

      const part = ABSORBABLE_PART_KINDS.map(
        (kind) => [kind, soleInjectedSpan(candidate, kind)] as const
      ).find(([, span]) => span !== null);
      // Not a part at all (operator prose, an assistant turn, a tool result):
      // the contiguous invocation group has ended.
      if (!part) break;

      const [kind, span] = part;
      // A second part of a kind already absorbed is not ours — leave it to
      // render standalone rather than overwriting the nearer one.
      if (span && !absorbed.has(kind)) {
        absorbed.set(kind, span);
        candidate.elements = [];
      }
    }

    const output = absorbed.get("local-command-output");
    const caveat = absorbed.get("local-command-caveat");

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
        />
      );
      return node;
    })
    .filter(Boolean);

  // A turn with no renderable elements (e.g. an empty pairing) is skipped by the caller.
  return (
    <div className={cn("flex flex-col gap-2 border-l-2 pl-3", accent)}>
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
function buildTurnNodes({
  preparedTurns,
  supersededGroups,
  blockIndexById,
  entityIndex,
  expandSignal,
}: {
  preparedTurns: PreparedTurn[];
  supersededGroups: SupersededGroup[];
  blockIndexById: Map<string, number>;
  entityIndex: EntityIndex;
  expandSignal: ExpandSignal;
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

  /**
   * Hide superseded (rewound) operator prompts (mt#3323).
   *
   * When the operator re-dictates or edits a prompt, the harness leaves the
   * superseded message in the transcript as a sibling branch. Rendering it as
   * an ordinary turn shows prose the agent never received — and in the
   * originating incident the superseded version read BETTER than the live one,
   * so the view was actively misleading.
   *
   * The blocks are marked upstream by `markAbandonedRewindBranches` at snapshot
   * assembly and are still PRESENT in `snapshot.blocks` (the session film joins
   * on `turnIndex`, so nothing may be removed there). Suppression is this
   * surface's decision, and the markers below keep it visible rather than
   * silent.
   *
   * Grouped BY POSITION rather than counted (mt#3361): each run of abandoned
   * prompts is anchored to the index of the live block that replaced it, so the
   * render can put a marker where the rewind actually happened instead of one
   * tally at the top of the view.
   */
  const { renderableBlocks, supersededGroups, blockIndexById } = useMemo(() => {
    const kept: SessionContextSnapshotBlock[] = [];
    const groups: SupersededGroup[] = [];
    const indexById = new Map<string, number>();
    let pending: SupersededPrompt[] = [];

    allBlocks.forEach((block, index) => {
      if (block.isAbandonedBranch === true) {
        // Collect operator PROMPTS, not blocks. A superseded prompt drags along
        // both its attachment blocks and — when the operator rewound after the
        // agent had already started working — the tool-result lines from the
        // abandoned attempt. `rawJsonlType === "user"` matches those tool
        // results too, so counting blocks would overstate a rewind that
        // superseded 2 prompts (PR #2419 R1).
        if (isOperatorPrompt(block)) {
          pending.push({ blockId: block.id, text: supersededPromptText(block) });
        }
        return;
      }

      indexById.set(block.id, index);
      kept.push(block);
      if (pending.length > 0) {
        groups.push({ anchorIndex: index, prompts: pending });
        pending = [];
      }
    });

    // A rewind at the very end of the transcript has no live block to anchor
    // to; `allBlocks.length` sorts it after every rendered turn.
    if (pending.length > 0) {
      groups.push({ anchorIndex: allBlocks.length, prompts: pending });
    }

    return { renderableBlocks: kept, supersededGroups: groups, blockIndexById: indexById };
  }, [allBlocks]);

  // The spawn→child map is resolved server-side and rides on the snapshot
  // (mt#3692) — the join is keyed on each Agent call's tool_use id, which is the
  // only identity shared by `agent_spawns` and the blocks rendered here.
  const spawnChildren = snapshot.spawnChildrenByToolUseId;
  const turns = useMemo(
    () => snapshotBlocksToConversation(renderableBlocks, spawnChildren),
    [renderableBlocks, spawnChildren]
  );

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

  /**
   * Where the rendered window STARTS, as an index into `visibleTurns` — `null`
   * until the operator has revealed anything.
   *
   * The null-vs-index distinction is load-bearing. While `null` the window is
   * DERIVED (`length - INITIAL_TURNS`) and therefore tracks the tail, so a live
   * session appending turns keeps showing the newest fifty — right for a reader
   * who has not scrolled. The first reveal turns it into an INDEX, which stops
   * moving, so later appends cannot push revealed history back out of the
   * window.
   *
   * Before mt#3688 both this and the separate "show all" flag were counts from
   * the TAIL, and `slice(length - count)` shifts forward as the tail grows: each
   * arriving turn silently re-hid one the operator had explicitly asked for. The
   * old "show all" carried a comment about exactly this hazard (PR #1667 R1) and
   * solved it only for itself; an index solves it for both, which is why the two
   * states collapse into this one — "show all" is just `revealedFrom === 0`.
   */
  // One-shot gate for the initial scroll-to-newest. Declared before the
  // session-change effect below, which re-arms it.
  const didInitialScrollRef = useRef(false);

  /**
   * Re-arm the one-shot on a genuine session SWAP — not on mount.
   *
   * Two details are load-bearing, and getting either wrong disables the
   * scroll-driven reveal silently (found by
   * `scripts/verify-conversation-orientation.ts`, which is the only place it is
   * observable — happy-dom cannot scroll):
   *
   *   - It compares the key rather than firing on every run of the effect. As a
   *     plain mount effect it re-armed on MOUNT too, landing AFTER the layout
   *     effect below had set the gate — so the gate read false for the entire
   *     session and `isNearTop` was never consulted.
   *   - It is a LAYOUT effect, so on a real swap the reset lands before the
   *     scroll effect below reads the gate. As a passive effect it would run
   *     after, clobbering the flag that effect had just set.
   *
   * The render window resets on the same key, inside `useThreadWindow`.
   */
  const lastSessionKeyRef = useRef(snapshot.agentSessionId);
  useLayoutEffect(() => {
    if (lastSessionKeyRef.current === snapshot.agentSessionId) return;
    lastSessionKeyRef.current = snapshot.agentSessionId;
    didInitialScrollRef.current = false;
  }, [snapshot.agentSessionId]);

  /**
   * Whether the live tail should follow new content — false once the operator
   * has scrolled up to read history (mt#3376). Declared here, ahead of the
   * window hook, because a reveal that jumps to the start clears it.
   */
  const pinnedRef = useRef(true);

  /**
   * The resolved scrollport, as STATE so that everything depending on it — the
   * scroll listener below, the measurement effect further down — moves together
   * the moment the resolution changes (mt#3445).
   *
   * It is state rather than a ref because the resolution genuinely changes
   * mid-session and nothing else announces it: `findScrollParent` only accepts
   * an ancestor that ALREADY overflows, and a live thread spends its first
   * seconds too short to overflow anything, so the first answer is always the
   * document fallback. Keying the listener on a ref left it bound to an element
   * that does not scroll — the reader's scrolling was then never heard, and
   * whether it ever corrected depended on a ResizeObserver bump landing at the
   * right moment (observed: it often did not, for a whole session).
   *
   * The REF half is what the window hook and the measurement effect read, since
   * both run outside render and want the resolution as of right now.
   */
  const scrollportRef = useRef<Element | null>(null);
  const [scrollport, setScrollport] = useState<Element | null>(null);

  const {
    hiddenBefore,
    isRevealing,
    revealingCount,
    revealOlder,
    revealFromStart,
    paintPosition,
    positionFillRef,
    positionReadoutRef,
  } = useThreadWindow({
    totalTurns: visibleTurns.length,
    sessionKey: snapshot.agentSessionId,
    scrollportRef,
    pinnedRef,
  });

  const windowedTurns = useMemo(
    () => visibleTurns.slice(hiddenBefore),
    [visibleTurns, hiddenBefore]
  );

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
  // The sentinel as STATE as well as a ref, because everything that measures
  // this thread hangs off it and a ref alone cannot wake an effect when it
  // arrives (mt#3445). A live session mounts EMPTY — the early return above
  // renders no sentinel — so a mount-time effect reading `endRef.current` binds
  // to nothing and never rebinds once the first turn lands.
  const [endNode, setEndNode] = useState<HTMLDivElement | null>(null);
  const attachEnd = useCallback((node: HTMLDivElement | null) => {
    endRef.current = node;
    setEndNode(node);
  }, []);
  useLayoutEffect(() => {
    if (didInitialScrollRef.current) return;
    if (preparedTurns.length === 0) return;
    didInitialScrollRef.current = true;
    if (hiddenBefore > 0) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
    // Keyed on the session too, so a swap whose new transcript happens to have
    // the same turn count and window still re-runs this and re-lands on its
    // newest turn — and re-sets the gate the reset above just cleared.
  }, [preparedTurns.length, hiddenBefore, snapshot.agentSessionId]);

  // Live-tail auto-scroll: when live content arrives (the SSE stream, mt#2232,
  // or a driven session's WS frames), scroll to the bottom so the operator sees
  // it — but ONLY when the operator is already at the bottom (mt#3376).
  // Scrolling unconditionally yanked the view out from under anyone reading
  // back through an active session, once per arriving tool call or message.
  const extraBlocksLen = extraBlocks?.length ?? 0;
  const [hasNewBelow, setHasNewBelow] = useState(false);

  // Forces a re-render whenever the thread's own box changes size — the signal
  // that layout, not content, may have created or removed a scrollport.
  // `ResizeObserver` catches in-page causes (a tool block expanding, a sibling
  // panel opening) that a window-resize listener alone would miss; the window
  // listener is the fallback where `ResizeObserver` is unavailable (older test
  // DOMs).
  //
  // The COUNT is deliberately never read (PR #2469 R2). What this state exists
  // for is the render it schedules: the resolution effect below re-runs on every
  // render, so scheduling one is the whole mechanism, and there is nothing for a
  // dependency array to compare. Do not delete it as unused — a window resize
  // that gives the thread a scrollport, or takes one away, changes no other
  // state, so without this the view would keep measuring a stale scrollport.
  const [, setLayoutTick] = useState(0);
  useEffect(() => {
    const bump = () => setLayoutTick((t) => t + 1);
    const target = endNode?.parentElement;
    if (typeof ResizeObserver === "function" && target) {
      const observer = new ResizeObserver(bump);
      observer.observe(target);
      return () => observer.disconnect();
    }
    if (typeof window === "undefined") return;
    window.addEventListener("resize", bump);
    return () => window.removeEventListener("resize", bump);
    // Keyed on the sentinel NODE, not `[]`: it does not exist on the first
    // commit of a live session, and a `[]` effect would observe nothing for the
    // rest of the session (mt#3445).
  }, [endNode]);

  // Keep `pinnedRef` current from the scrollport itself. Sampling at append
  // time would be too late — the append is what moves the scroll.
  useEffect(() => {
    if (!scrollport) return;
    /** Sample the scrollport. Runs on mount AND on every scroll. */
    const sample = () => {
      const pinned = isPinnedToBottom(scrollport);
      pinnedRef.current = pinned;
      // Scrolling back down by hand dismisses the affordance too — the
      // operator has caught up, so there is nothing left to point at.
      if (pinned) setHasNewBelow(false);
      paintPosition(scrollport);
    };
    /**
     * Reveal older turns as the reader approaches the top.
     *
     * Bound to the EVENT only, deliberately never to the priming call below. A
     * reveal answers the reader scrolling; it must not answer this component
     * re-resolving its scrollport, which happens on a schedule of its own (the
     * resolution effect re-runs on every render, and the resolution genuinely
     * moves mid-session — mt#3445). Priming at scrollTop 0 would read as "near
     * the top" every time that happened, and since each reveal re-renders, the
     * result was a loop that unwound the whole window in one mount — mounting
     * the entire transcript, the precise cost the window exists to avoid.
     */
    const onScroll = () => {
      sample();
      if (didInitialScrollRef.current && isNearTop(scrollport)) revealOlder();
    };
    sample();
    scrollport.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollport.removeEventListener("scroll", onScroll);
    // Just the resolved element. Whether an element scrolls is a LAYOUT fact,
    // not a content-count fact (PR #2459 R1, non-blocking) — and the resolution
    // effect below already re-runs on every render, so a re-resolution reaches
    // this listener by changing the thing it is keyed on, rather than by this
    // effect guessing which inputs might have moved it.
    //
    // The two callbacks are stable by construction (`useCallback` over refs, not
    // over the window state), so listing them satisfies exhaustive-deps without
    // reintroducing the per-chunk re-binding this key deliberately avoids.
  }, [scrollport, paintPosition, revealOlder]);

  const scrollToEnd = useCallback(() => {
    endRef.current?.scrollIntoView({ block: "end" });
    pinnedRef.current = true;
  }, []);

  const scrollToNewest = useCallback(() => {
    scrollToEnd();
    setHasNewBelow(false);
  }, [scrollToEnd]);

  // The last state the arrival check ran against. `extraBlocks` is replaced
  // wholesale by every accumulator fold (`upsertBlock` returns a new array in
  // both its append and its in-place-replace branch), so its IDENTITY is an
  // exact, O(1) "live content arrived" signal — where its LENGTH is not, since
  // a streaming turn folds every delta into one block id.
  const prevExtraBlocksRef = useRef(extraBlocks);
  const prevExtraBlocksLenRef = useRef(extraBlocksLen);
  const prevHeightRef = useRef<number | null>(null);

  // Decide what to do about content that arrived (mt#3445). Runs on every
  // render rather than on a turn count, because the case that matters most —
  // a single assistant turn streaming for a minute — never changes the count.
  //
  // Two independent signals, both required:
  //   - identity: did live content actually arrive, or did the thread just
  //     reflow? Expanding a tool block grows the thread by hundreds of pixels
  //     and is not "new messages below".
  //   - height: did that arrival land BELOW the reader? A count bump answers
  //     this for a new turn; only a measurement answers it for in-place growth.
  //
  // The measurement is one `scrollHeight` read in a layout effect — the same
  // layout the frame is about to perform anyway, and cheaper than the
  // `scrollIntoView` this effect already ran per turn before mt#3445.
  useLayoutEffect(() => {
    const contentArrived = extraBlocks !== prevExtraBlocksRef.current;
    const countGrew = extraBlocksLen > prevExtraBlocksLenRef.current;
    prevExtraBlocksRef.current = extraBlocks;
    prevExtraBlocksLenRef.current = extraBlocksLen;

    // Re-resolve unless the cached element is ACTUALLY scrolling. The cache is
    // an optimization, and a resolution that landed on the document fallback is
    // exactly the one that must not stick: it reports a constant height, so no
    // growth is ever measurable against it and no scroll of the reader's is
    // ever heard. Correcting it must not depend on a ResizeObserver bump
    // arriving at the right moment — that was observed failing for a whole
    // session, leaving the affordance silent while the thread doubled in height.
    const cached = scrollportRef.current;
    const resolved =
      cached && cached.scrollHeight > cached.clientHeight
        ? cached
        : findScrollParent(endRef.current);
    if (resolved !== cached) {
      scrollportRef.current = resolved;
      // Wakes the scroll listener above onto the element that actually scrolls.
      setScrollport(resolved);
    }
    if (!resolved) return;

    const height = resolved.scrollHeight;
    const previousHeight = prevHeightRef.current;
    prevHeightRef.current = height;

    if (!contentArrived) return;
    if (!countGrew && !hasGrown(previousHeight, height)) return;

    if (pinnedRef.current) {
      scrollToEnd();
      return;
    }
    // Reading history: hold position and say something arrived instead.
    setHasNewBelow(true);
  });

  if (visibleTurns.length === 0) {
    // A transcript can be ALL superseded prompts — the operator rewrote every
    // message before the agent answered any of them. Returning the bare
    // empty-state here would silently discard the only content the session
    // has, which is the exact failure this marker exists to prevent (PR #2449
    // R1). The markers render on their own instead.
    if (supersededGroups.length > 0) {
      return (
        <div className={cn("flex flex-col gap-3", className)}>
          <p className="text-sm text-muted-foreground">
            Every message in this session was superseded — the operator rewrote each one before the
            agent received it.
          </p>
          {supersededGroups.map((group) => (
            <SupersededPromptMarker key={supersededMarkerKey(group)} prompts={group.prompts} />
          ))}
        </div>
      );
    }
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        This session has no conversational turns to display.
      </p>
    );
  }

  return (
    // `[overflow-anchor:none]` opts the thread OUT of the browser's scroll
    // anchoring (mt#3688). The reveal corrects the scroll itself, because the
    // platform mechanism does not exist in WebKit — the engine the tray's macOS
    // window uses — and a correction competing with an anchor on the engines
    // that DO implement it would double-count the prepended height.
    <div className={cn("flex flex-col gap-4 [overflow-anchor:none]", className)}>
      <SpawnParentBacklink parent={snapshot.spawnParent} />
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
      <ThreadStartBoundary
        hiddenBefore={hiddenBefore}
        isRevealing={isRevealing}
        revealingCount={revealingCount}
        firstTurnAt={visibleTurns[0]?.timestamp}
        onRevealOlder={revealOlder}
        onRevealFromStart={revealFromStart}
      />
      {buildTurnNodes({
        preparedTurns,
        supersededGroups,
        blockIndexById,
        entityIndex,
        expandSignal,
      })}
      {/* Return-to-newest (mt#3376). Rendered only while the operator is
          scrolled up AND live content has arrived since — the two conditions
          that together mean "you are missing something below". Sticky so it
          stays reachable while they keep reading. */}
      {hasNewBelow && (
        <button
          type="button"
          onClick={scrollToNewest}
          data-testid="jump-to-newest"
          className="sticky bottom-2 z-10 mx-auto w-fit rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground shadow-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          New messages below ↓
        </button>
      )}
      {/* Shown only once the conversation is long enough that the window
          mechanism engaged at all (mt#3688). Below INITIAL_TURNS every turn is
          rendered, so the native scrollbar already tells the truth and a
          floating readout would be chrome for its own sake. */}
      {visibleTurns.length > INITIAL_TURNS && (
        <ThreadPositionPill
          fillRef={positionFillRef}
          readoutRef={positionReadoutRef}
          totalTurns={visibleTurns.length}
          hiddenBefore={hiddenBefore}
          onRevealFromStart={revealFromStart}
        />
      )}
      {/* `scroll-mb-8` is load-bearing (mt#3344), not spacing: both
          `scrollIntoView({block:"end"})` calls above align THIS sentinel's
          bottom edge to the scrollport's bottom edge, which would park the
          newest turn exactly where the tail's `sticky bottom-0` activity strip
          floats — so the strip would cover the turn it is reporting on.
          `scroll-margin-bottom` is honored by `scrollIntoView`, so this
          reserves the strip's height without shifting anything in normal flow. */}
      <div ref={attachEnd} aria-hidden className="scroll-mb-8" />
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
