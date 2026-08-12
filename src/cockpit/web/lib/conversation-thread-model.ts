/**
 * Snapshot blocks → the model a transcript thread renders from (mt#4024).
 *
 * Moved out of `widgets/ConversationView.tsx`, where it was the first half of
 * that component and the reason nothing else could render a thread. The
 * published share page needs the identical model — same rewind suppression,
 * same tool-name map, same emptiness filter — for a reader with no account,
 * and building a second one would have meant two answers to "which turns does
 * this conversation have."
 *
 * Pure and hook-free: the caller owns memoization. `ConversationView` wraps it
 * in a `useMemo` keyed on the blocks; the share page does the same.
 */
import { snapshotBlocksToConversation } from "@minsky/domain/transcripts/conversation-elements";
import type { ConversationTurn } from "@minsky/domain/transcripts/conversation-elements";
import { isOperatorPrompt } from "@minsky/domain/transcripts/rewind-detection";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";
import {
  supersededPromptText,
  type SupersededGroup,
  type SupersededPrompt,
} from "../components/SupersededPromptMarker";

export interface ConversationThreadModel {
  /** Blocks that survive rewind suppression — what the turns were built from. */
  renderableBlocks: SessionContextSnapshotBlock[];
  /** Suppressed operator prompts, anchored to where the rewind happened. */
  supersededGroups: SupersededGroup[];
  /** Block id → its position in `renderableBlocks`; marker ordering only. */
  blockIndexById: Map<string, number>;
  /** Block id → the transcript position the snapshot stamped on it (mt#3791). */
  turnIndexByBlockId: Map<string, number>;
  /** The inverse, for resolving an incoming turn address to a block. */
  blockIdByTurnIndex: Map<number, string>;
  /** Every tool_use id → the tool it called, so a result can name its call. */
  callNameByToolUseId: Map<string, string>;
  /** Turns with something to render, in order. */
  visibleTurns: ConversationTurn[];
}

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
 * on `turnIndex`, so nothing may be removed there). Suppression is the render
 * surface's decision, and the markers this returns keep it visible rather than
 * silent.
 *
 * Grouped BY POSITION rather than counted (mt#3361): each run of abandoned
 * prompts is anchored to the index of the live block that replaced it, so the
 * render can put a marker where the rewind actually happened instead of one
 * tally at the top of the view.
 */
export function buildConversationThread(
  allBlocks: SessionContextSnapshotBlock[],
  spawnChildrenByToolUseId?: SessionContextSnapshot["spawnChildrenByToolUseId"]
): ConversationThreadModel {
  const kept: SessionContextSnapshotBlock[] = [];
  const groups: SupersededGroup[] = [];
  const indexById = new Map<string, number>();
  // The two address maps (mt#3791). Keyed on the block's own `turnIndex`
  // rather than its position in this array: `turnIndex` is optional on the
  // block type, and a live-tail or unstamped block would otherwise be given
  // an address that points at somebody else's line.
  const turnIndexById = new Map<string, number>();
  const idByTurnIndex = new Map<number, string>();
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
    if (block.turnIndex !== undefined) {
      turnIndexById.set(block.id, block.turnIndex);
      idByTurnIndex.set(block.turnIndex, block.id);
    }
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

  // The spawn→child map is resolved server-side and rides on the snapshot
  // (mt#3692) — the join is keyed on each Agent call's tool_use id, which is the
  // only identity shared by `agent_spawns` and the blocks rendered here.
  const turns = snapshotBlocksToConversation(kept, spawnChildrenByToolUseId);

  // Map every tool_use id → tool name so a tool-result can name the call it
  // answers. Computed over ALL turns (not a window): a windowed tool-result may
  // answer a call that is currently outside the window.
  const callNameByToolUseId = new Map<string, string>();
  for (const turn of turns) {
    for (const el of turn.elements) {
      if (el.kind === "tool-call" && el.id) callNameByToolUseId.set(el.id, el.name);
    }
  }

  // Drop turns with nothing renderable (e.g. empty user pairings).
  const visibleTurns = turns.filter((t) =>
    t.elements.some((e) =>
      e.kind === "text"
        ? e.text.trim().length > 0
        : e.kind === "thinking"
          ? e.thinking.trim().length > 0
          : true
    )
  );

  return {
    renderableBlocks: kept,
    supersededGroups: groups,
    blockIndexById: indexById,
    turnIndexByBlockId: turnIndexById,
    blockIdByTurnIndex: idByTurnIndex,
    callNameByToolUseId,
    visibleTurns,
  };
}
