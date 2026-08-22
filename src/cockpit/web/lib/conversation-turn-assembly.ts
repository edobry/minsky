/**
 * Pre-render turn assembly for the conversation thread (extracted mt#3791).
 *
 * Two passes that run over the turns about to be rendered, before any JSX:
 * pairing each tool call with its result, and folding a slash command's output
 * and caveat into the command element. Both are pure functions over turns, and
 * both were written inline in `ConversationView.tsx` (mt#2790, mt#3322) until
 * that file hit its 1500-line ceiling — the same reason `SpawnParentBacklink`
 * and the per-element renderers were split out before them. Behavior is
 * unchanged by the move; the section comments below are the originals.
 *
 * @see ../components/ConversationElementRenderers.tsx — the element renderers
 *   these passes produce input for (mt#3262 extraction)
 */
import type {
  ConversationRole,
  ConversationTurn,
} from "@minsky/domain/transcripts/conversation-elements";
import type {
  PreparedElement,
  ToolCallElement,
  ToolResultElement,
} from "../components/ConversationElementRenderers";
import {
  splitInjectedContent,
  type InjectedContentKind,
  type InjectedSpan,
} from "./injected-content";

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

export interface PreparedTurn {
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
  /**
   * Who authored this `user` turn's text (mt#4354), from the one classifier
   * that also writes `agent_transcript_turns.user_origin` (mt#4289).
   * `"human"` is its FAIL-OPEN default — only a non-`"human"` value informs.
   */
  userOrigin?: string;
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
export function pairToolInvocations(
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
      userOrigin: turn.userOrigin,
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

export function mergeCommandInvocations(turns: PreparedTurn[]): PreparedTurn[] {
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

export function hasRenderablePreparedElement(el: PreparedElement): boolean {
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
