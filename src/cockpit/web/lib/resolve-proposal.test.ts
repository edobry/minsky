/**
 * Tests for the thread block-list proposal search (mt#3368).
 *
 * The marker parser itself is tested in `packages/shared/src/resolve-proposal.test.ts`;
 * what is under test here is WHICH blocks are eligible to carry a proposal.
 */
import { describe, expect, test } from "bun:test";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { RESOLVE_PROPOSAL_FENCE, findLatestResolveProposal } from "./resolve-proposal";

function fenced(letter: string): string {
  return `\`\`\`${RESOLVE_PROPOSAL_FENCE}\n{"optionLetter": "${letter}"}\n\`\`\``;
}

function block(
  overrides: Partial<SessionContextSnapshotBlock> & { id: string }
): SessionContextSnapshotBlock {
  return {
    type: "assistant-text",
    source: "observed",
    content: "",
    ...overrides,
  } as SessionContextSnapshotBlock;
}

describe("findLatestResolveProposal", () => {
  test("finds a proposal in the agent's reply", () => {
    const blocks = [
      block({ id: "1", type: "user-prompt", content: "should I approve this?" }),
      block({ id: "2", content: `No — here is why.\n\n${fenced("B")}` }),
    ];
    expect(findLatestResolveProposal(blocks)?.optionLetter).toBe("B");
  });

  test("an empty thread has no proposal", () => {
    expect(findLatestResolveProposal([])).toBeNull();
  });

  test("prose-only agent turns yield no proposal", () => {
    const blocks = [block({ id: "1", content: "I can't tell what this ask is asking." })];
    expect(findLatestResolveProposal(blocks)).toBeNull();
  });

  test("the NEWEST agent proposal wins over an earlier one", () => {
    const blocks = [
      block({ id: "1", content: fenced("A") }),
      block({ id: "2", type: "user-prompt", content: "are you sure?" }),
      block({ id: "3", content: fenced("C") }),
    ];
    expect(findLatestResolveProposal(blocks)?.optionLetter).toBe("C");
  });

  test("a marker the OPERATOR typed is NOT treated as an agent proposal", () => {
    // The control claims "the agent proposes this". Honoring an operator-authored
    // marker would make that claim false — and would let the panel present a
    // person's own text back to them as an independent recommendation.
    const blocks = [block({ id: "1", type: "user-prompt", content: fenced("B") })];
    expect(findLatestResolveProposal(blocks)).toBeNull();
  });

  test("an operator marker does not shadow an older genuine agent proposal", () => {
    const blocks = [
      block({ id: "1", content: fenced("A") }),
      block({ id: "2", type: "user-prompt", content: fenced("Z") }),
    ];
    expect(findLatestResolveProposal(blocks)?.optionLetter).toBe("A");
  });

  test("a non-string block content is skipped, not coerced", () => {
    // `content` is `unknown` on the block type — attachment blocks carry
    // structured payloads. Coercing one would feed "[object Object]" to the parser.
    const blocks = [block({ id: "1", content: { attachment: true } })];
    expect(findLatestResolveProposal(blocks)).toBeNull();
  });
});
