/**
 * Rewind detection over a snapshot block stream (mt#3323).
 *
 * Claude Code transcripts are a `parentUuid` TREE, not a list. When the
 * operator rewinds — re-dictates or edits a prompt — the superseded message
 * stays in the file as a sibling branch under the same `parentUuid`. Rendering
 * the stream in file order shows that superseded prose as an ordinary turn, so
 * the cockpit displays operator text the agent never received (mt#3323's
 * motivating incident: conversation `77c6ca4f-…`).
 *
 * ## Why this does NOT linearize the whole tree
 *
 * Branching is the NORMAL shape of these transcripts, and almost none of it is
 * abandonment. A parallel tool batch writes one `assistant` row per `tool_use`,
 * and each row's `tool_result` lands as a SIBLING of the next `tool_use` row —
 * so the tree forks at every parallel call site with BOTH forks live. Measured
 * over 207 local transcripts (2026-07-29): **4,187 parallel-tool-call branch
 * points vs 25 genuine rewinds**, and only 8.2% of conversations have no branch
 * point at all. Walking root→live-leaf and dropping everything off-path would
 * have removed 43 of 378 renderable rows (11.4%) from the motivating
 * conversation, including 23 real `tool_result`s the agent actually received —
 * to fix ONE message.
 *
 * So the trigger here is the REWIND SHAPE specifically: two or more sibling
 * blocks under one `parentUuid` that are operator prompts and NOT tool results.
 * Generic tree branching is deliberately not a trigger.
 *
 * ## Why it marks instead of filtering
 *
 * `SemanticEvent.turnIndex` is documented as index-identical with
 * `SessionContextSnapshotBlock.turnIndex` (`event-schema.ts`), and
 * `event-adapter.test.ts`'s round-trip test rests on that identity; the session
 * film indexes blocks by it. Removing or re-indexing blocks here would break
 * that join. This module therefore only SETS `isAbandonedBranch` — deciding
 * what to hide is the renderer's job, which also satisfies mt#3323's
 * "abandoned branches are not silently destroyed" constraint.
 *
 * @see mt#3323 — this module
 * @see packages/domain/src/transcripts/session-context-snapshot.ts — the caller
 */

import type { SessionContextSnapshotBlock } from "../context/types";

/**
 * Does this block's message content carry a `tool_result`?
 *
 * Load-bearing: `mapTurnTypeToBlockType` maps EVERY `user` JSONL line to
 * `"user-prompt"`, tool results included, so the block `type` alone cannot tell
 * an operator prompt from a tool result. Without this check the detector would
 * fire on parallel tool batches — the exact 4,187-vs-25 regression described in
 * the module doc.
 */
function carriesToolResult(block: SessionContextSnapshotBlock): boolean {
  const message = block.content;
  if (message === null || typeof message !== "object") return false;
  const parts = (message as Record<string, unknown>).content;
  if (!Array.isArray(parts)) return false;
  return parts.some(
    (part) =>
      part !== null &&
      typeof part === "object" &&
      (part as Record<string, unknown>).type === "tool_result"
  );
}

/**
 * An operator-authored prompt — a `user` line that is not a tool result.
 *
 * Exported because the render surface needs the SAME definition: `rawJsonlType
 * === "user"` alone also matches tool-result lines, so counting on it would
 * report a rewind that superseded 2 prompts as having superseded many more
 * (PR #2419 R1 BLOCKING).
 */
export function isOperatorPrompt(block: SessionContextSnapshotBlock): boolean {
  return block.rawJsonlType === "user" && !carriesToolResult(block);
}

/**
 * Collect every block reachable from `rootUuid` by following `parentUuid`
 * edges, including the root's own block.
 *
 * Each block is collected EXACTLY ONCE: a uuid-bearing child is collected when
 * it is dequeued (not when it is seen as a child), while a uuid-less child —
 * an attachment, which has `parent_uuid` but no `uuid` column and so can never
 * be a parent — is collected inline because it will never be dequeued.
 *
 * Cycle-safe: a `visited` set bounds the walk, so an adversarial or corrupted
 * `parentUuid` cycle terminates instead of looping forever.
 */
function collectSubtree(
  rootUuid: string,
  childrenByParent: Map<string, SessionContextSnapshotBlock[]>,
  blocksByUuid: Map<string, SessionContextSnapshotBlock>
): SessionContextSnapshotBlock[] {
  const collected: SessionContextSnapshotBlock[] = [];
  const visited = new Set<string>();
  const queue: string[] = [rootUuid];

  while (queue.length > 0) {
    const uuid = queue.shift() as string;
    if (visited.has(uuid)) continue;
    visited.add(uuid);

    const block = blocksByUuid.get(uuid);
    if (block !== undefined) collected.push(block);

    for (const child of childrenByParent.get(uuid) ?? []) {
      if (child.uuid === undefined) {
        // Attachment chains deeper than one hop are unreachable — a known,
        // deliberate limitation rather than a silent gap (mt#3323).
        collected.push(child);
      } else if (!visited.has(child.uuid)) {
        queue.push(child.uuid);
      }
    }
  }

  return collected;
}

/** Does this subtree contain an assistant turn — i.e. did the agent answer it? */
function hasAssistantDescendant(subtree: SessionContextSnapshotBlock[]): boolean {
  return subtree.some((block) => block.rawJsonlType === "assistant");
}

/**
 * The BLOCK IDS this stream's rewind shapes supersede.
 *
 * ## Live-branch selection rule (deterministic)
 *
 * Among the sibling operator prompts sharing one `parentUuid`:
 *
 * 1. Prefer the sibling whose subtree contains an assistant turn — the agent
 *    demonstrably answered that one. In the motivating conversation this is
 *    unambiguous: the superseded branch has ZERO assistant descendants, the
 *    live branch has 215.
 * 2. If that leaves zero or several candidates (the operator rewound and the
 *    conversation ended, so nothing was answered), fall back to the LATEST by
 *    timestamp, tie-broken by the block's stable `id`. Deterministic and stable
 *    across repeated runs over the same input.
 *
 * Everything not selected is marked, along with its reachable descendants.
 *
 * ## Why this is split from the marking step, and returns ids (mt#4263)
 *
 * Split out of `markAbandonedRewindBranches` for mt#4263. A windowed snapshot
 * cannot compute this from the blocks it returns: the rule above picks the live
 * branch by comparing SIBLING SUBTREES, and a tail window truncates both sides
 * of that comparison — so the same conversation yields a different verdict
 * depending on where the window happens to cut, which is a wrong answer rather
 * than a partial one. The windowed path therefore runs this over a
 * structure-only projection of the FULL transcript (ids, uuid/parentUuid,
 * timestamp, type, tool-result-ness — no message content) and applies the
 * resulting id set to the blocks it actually returns.
 *
 * Ids rather than object identity because the set has to survive that crossing:
 * the projection's block objects are not the objects the window returns. Block
 * ids are unique per snapshot by construction (`<sessionId>:turn:<index>` /
 * `<sessionId>:attachment:<index>`), so this is identity-equivalent for the
 * unwindowed caller below.
 */
export function computeAbandonedBlockIds(blocks: SessionContextSnapshotBlock[]): Set<string> {
  const blocksByUuid = new Map<string, SessionContextSnapshotBlock>();
  const childrenByParent = new Map<string, SessionContextSnapshotBlock[]>();

  for (const block of blocks) {
    if (block.uuid !== undefined) blocksByUuid.set(block.uuid, block);
    if (block.parentUuid === undefined) continue;
    const siblings = childrenByParent.get(block.parentUuid);
    if (siblings === undefined) childrenByParent.set(block.parentUuid, [block]);
    else siblings.push(block);
  }

  const abandoned = new Set<string>();

  for (const siblings of childrenByParent.values()) {
    const prompts = siblings.filter(isOperatorPrompt);
    // One operator prompt is the ordinary case; zero means this is a
    // tool-result / attachment fork, which is live on every branch.
    if (prompts.length < 2) continue;

    const subtrees = new Map<SessionContextSnapshotBlock, SessionContextSnapshotBlock[]>();
    for (const prompt of prompts) {
      subtrees.set(
        prompt,
        prompt.uuid === undefined
          ? [prompt]
          : collectSubtree(prompt.uuid, childrenByParent, blocksByUuid)
      );
    }

    const answered = prompts.filter((prompt) =>
      hasAssistantDescendant(subtrees.get(prompt) as SessionContextSnapshotBlock[])
    );
    const candidates = answered.length === 1 ? answered : prompts;
    const ordered = [...candidates].sort(
      (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)
    );
    const live = ordered[ordered.length - 1] as SessionContextSnapshotBlock;

    for (const prompt of prompts) {
      if (prompt === live) continue;
      for (const block of subtrees.get(prompt) as SessionContextSnapshotBlock[])
        abandoned.add(block.id);
    }
  }

  return abandoned;
}

/**
 * Apply an already-computed abandoned-id set to `blocks`.
 *
 * Returns the SAME array reference when nothing in it is marked, preserving the
 * caller-visible "untouched on the common path" property the unwindowed
 * assembler relies on.
 */
export function applyAbandonedBlockIds(
  blocks: SessionContextSnapshotBlock[],
  abandoned: ReadonlySet<string>
): SessionContextSnapshotBlock[] {
  if (abandoned.size === 0) return blocks;
  if (!blocks.some((block) => abandoned.has(block.id))) return blocks;

  return blocks.map((block) =>
    abandoned.has(block.id) ? { ...block, isAbandonedBranch: true } : block
  );
}

/**
 * Mark blocks belonging to superseded (rewound) operator-prompt branches with
 * `isAbandonedBranch: true`.
 *
 * Whole-stream form: computes the abandoned set from the same blocks it marks.
 * Correct only when `blocks` IS the whole conversation — which is exactly the
 * unwindowed assembler's case. A windowed caller composes the two halves
 * itself, running `computeAbandonedBlockIds` over a full-transcript projection.
 *
 * Returns the SAME array reference when nothing is marked, so a conversation
 * with no rewind is untouched — the common path is not perturbed.
 */
export function markAbandonedRewindBranches(
  blocks: SessionContextSnapshotBlock[]
): SessionContextSnapshotBlock[] {
  return applyAbandonedBlockIds(blocks, computeAbandonedBlockIds(blocks));
}
