import { describe, expect, test } from "bun:test";
import {
  WriterDivergenceScanner,
  buildParentByUuid,
  collectLastPromptLeaves,
  detectWriterDivergence,
} from "./writer-divergence";
import {
  SPECIMEN_BRANCH_A_TIP as BRANCH_A_TIP,
  SPECIMEN_BRANCH_B_TIP as BRANCH_B_TIP,
  SPECIMEN_SHARED_ANCESTOR_LEAF as SHARED_ANCESTOR_LEAF,
  WRITER_DIVERGENCE_SPECIMEN,
} from "./__fixtures__/writer-divergence-specimen";

/**
 * The real specimen (mt#3656): a two-writer fork produced deliberately against
 * claude 2.1.222. Branch A tip `df8b0632`, branch B tip `49eaa830`, both under
 * `1b0208f8`; the earlier `last-prompt` `32d6a308` is an ancestor of both.
 */
function specimenLines(): readonly unknown[] {
  return WRITER_DIVERGENCE_SPECIMEN;
}

/** Build a parent map from `[uuid, parentUuid]` pairs. */
function tree(...edges: Array<[string, string | null]>): Map<string, string | null> {
  return new Map(edges);
}

describe("detectWriterDivergence — the real two-writer specimen", () => {
  test("identifies both branch tips as divergent", () => {
    const lines = specimenLines();
    const verdict = detectWriterDivergence(
      collectLastPromptLeaves(lines),
      buildParentByUuid(lines)
    );

    expect(verdict.divergentTips.sort()).toEqual([BRANCH_B_TIP, BRANCH_A_TIP].sort());
    expect(verdict.unresolvedLeaves).toEqual([]);
  });

  test("excludes the earlier last-prompt that is an ancestor of both branches", () => {
    const lines = specimenLines();
    const verdict = detectWriterDivergence(
      collectLastPromptLeaves(lines),
      buildParentByUuid(lines)
    );

    // Three `last-prompt` records exist, but only two name mutually-exclusive
    // branches — the pre-fork one is on the shared trunk, not a competing tip.
    expect(collectLastPromptLeaves(lines)).toHaveLength(3);
    expect(verdict.divergentTips).not.toContain(SHARED_ANCESTOR_LEAF);
  });

  test("the streaming scanner reaches the same verdict as the pure path", () => {
    const scanner = new WriterDivergenceScanner();
    for (const line of specimenLines()) scanner.observe(line);

    expect(scanner.leafCount).toBe(3);
    expect(scanner.verdict().divergentTips.sort()).toEqual([BRANCH_B_TIP, BRANCH_A_TIP].sort());
  });
});

describe("detectWriterDivergence — shapes that must NOT fire", () => {
  test("a linear conversation with many last-prompt records is not divergent", () => {
    // The common case: one real transcript carries 135 of these, all on one
    // chain. Firing here would make the signal useless.
    const edges: Array<[string, string | null]> = [["n0", null]];
    const leaves: string[] = ["n0"];
    for (let i = 1; i < 20; i++) {
      edges.push([`n${i}`, `n${i - 1}`]);
      leaves.push(`n${i}`);
    }

    const verdict = detectWriterDivergence(leaves, tree(...edges));

    expect(verdict.divergentTips).toEqual([]);
    expect(verdict.unresolvedLeaves).toEqual([]);
  });

  test("a supersede-before-answer fork with a single last-prompt is not divergent", () => {
    // Two sibling prompts under one parent — the shape the tree-side detector
    // sees — but only ONE writer ever completed a turn, so only one
    // `last-prompt` exists. One writer cannot diverge from itself.
    const parents = tree(
      ["root", null],
      ["promptA", "root"],
      ["promptB", "root"],
      ["replyB", "promptB"]
    );

    expect(detectWriterDivergence(["replyB"], parents).divergentTips).toEqual([]);
  });

  test("a single last-prompt naming a leaf is never divergent", () => {
    expect(detectWriterDivergence(["only"], tree(["only", null])).divergentTips).toEqual([]);
  });

  test("no last-prompt records at all yields no verdict and no leaves", () => {
    const verdict = detectWriterDivergence([], tree(["a", null]));
    expect(verdict.divergentTips).toEqual([]);
    expect(verdict.unresolvedLeaves).toEqual([]);
  });
});

describe("detectWriterDivergence — refuses to guess from an incomplete tree", () => {
  test("leaves absent from the tree are reported, not treated as branches", () => {
    // Two unplaceable leaves are not evidence of two branches. Reporting them
    // as divergent would let a truncated tree manufacture the verdict.
    const verdict = detectWriterDivergence(["ghostA", "ghostB"], tree(["real", null]));

    expect(verdict.divergentTips).toEqual([]);
    expect(verdict.unresolvedLeaves).toEqual(["ghostA", "ghostB"]);
  });

  test("a real divergence is still reported alongside an unresolvable leaf", () => {
    const parents = tree(["root", null], ["a", "root"], ["b", "root"]);
    const verdict = detectWriterDivergence(["a", "b", "ghost"], parents);

    expect(verdict.divergentTips.sort()).toEqual(["a", "b"]);
    expect(verdict.unresolvedLeaves).toEqual(["ghost"]);
  });
});

describe("WriterDivergenceScanner — why the parent map comes from the raw stream", () => {
  test("an attachment mid-chain keeps two same-branch leaves comparable", () => {
    // `attach` carries a uuid and sits BETWEEN two assistant rows. Both
    // `last-prompt` leaves are on ONE branch, so this must not fire.
    const lines = [
      { type: "assistant", uuid: "early", parentUuid: null },
      { type: "last-prompt", leafUuid: "early" },
      { type: "attachment", uuid: "attach", parentUuid: "early" },
      { type: "assistant", uuid: "late", parentUuid: "attach" },
      { type: "last-prompt", leafUuid: "late" },
    ];

    const scanner = new WriterDivergenceScanner();
    for (const line of lines) scanner.observe(line);

    expect(scanner.verdict().divergentTips).toEqual([]);
  });

  test("dropping the attachment node would fabricate a divergence", () => {
    // The same tree with the attachment omitted — what a parent map built from
    // `agent_transcripts.transcript` (user/assistant only) would look like.
    // `late`'s chain dead-ends at the missing `attach`, so the two leaves look
    // incomparable. This pins WHY the scanner reads the raw stream; it is the
    // failure the design avoids, not the behavior it ships.
    const holed = tree(["early", null], ["late", "attach"]);

    expect(detectWriterDivergence(["early", "late"], holed).divergentTips.sort()).toEqual([
      "early",
      "late",
    ]);
  });

  test("de-duplicates repeated last-prompt records naming one leaf", () => {
    const scanner = new WriterDivergenceScanner();
    scanner.observe({ type: "assistant", uuid: "n", parentUuid: null });
    scanner.observe({ type: "last-prompt", leafUuid: "n" });
    scanner.observe({ type: "last-prompt", leafUuid: "n" });

    expect(scanner.leafCount).toBe(1);
  });

  test("ignores malformed rows without throwing", () => {
    const scanner = new WriterDivergenceScanner();
    for (const line of [null, undefined, 42, "text", {}, { type: "last-prompt" }]) {
      scanner.observe(line);
    }

    expect(scanner.leafCount).toBe(0);
    expect(scanner.verdict().divergentTips).toEqual([]);
  });
});

describe("detectWriterDivergence — hostile input", () => {
  test("a parentUuid cycle terminates instead of hanging", () => {
    const cyclic = tree(["a", "b"], ["b", "a"], ["c", null]);

    const verdict = detectWriterDivergence(["a", "c"], cyclic);

    // The assertion that matters is that this returns at all; a cycle-unsafe
    // walk would never reach it.
    expect(verdict.unresolvedLeaves).toEqual([]);
    expect(Array.isArray(verdict.divergentTips)).toBe(true);
  });
});
