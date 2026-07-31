/**
 * Finding an agent's resolve proposal in an entity thread (mt#3368, parent mt#3363).
 *
 * The marker contract itself — the fence string and the validating parser — lives
 * in `@minsky/shared/resolve-proposal`, because the DAEMON writes that fence into
 * the agent's seed prompt while the BROWSER parses it back out; see that module's
 * docblock for why one definition rather than two.
 *
 * What this module adds is the block-list search, which needs the cockpit's
 * conversation-block shape and therefore cannot live in `shared`.
 *
 * @see mt#3368 — this module
 * @see ../components/ResolveProposalCard.tsx — the confirm control it feeds
 */

import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import {
  RESOLVE_PROPOSAL_FENCE,
  parseResolveProposal,
  type ResolveProposal,
} from "@minsky/shared/resolve-proposal";

// Re-exported so cockpit consumers have one import site for the whole contract
// (PR #2465 R1 non-blocking: this was previously a re-export plus a duplicate
// type-only import of the same symbol).
export { RESOLVE_PROPOSAL_FENCE, parseResolveProposal, type ResolveProposal };

/**
 * Find the most recent proposal across a thread's blocks.
 *
 * Scans newest-first and stops at the first hit, so a superseded proposal from
 * an earlier turn never resurfaces.
 *
 * Only `assistant-text` blocks are considered. An operator who pastes the fence
 * into their own message must not have it rendered back at them as an agent
 * proposal — the control's whole claim is "the AGENT proposes this," and
 * honoring an operator-authored marker would make that claim false.
 */
export function findLatestResolveProposal(
  blocks: readonly SessionContextSnapshotBlock[]
): ResolveProposal | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.type !== "assistant-text") continue;
    // `content` is `unknown` on the block type — turn blocks carry raw text but
    // attachment blocks carry a structured payload. Narrow rather than cast:
    // a non-string here is a block kind this search does not apply to, not an
    // error, and coercing one would feed `String([object Object])` to the parser.
    if (typeof block.content !== "string") continue;
    const proposal = parseResolveProposal(block.content);
    if (proposal) return proposal;
  }
  return null;
}
