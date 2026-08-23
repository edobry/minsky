/**
 * Actor-run grouping in the conversation thread (mt#3845 SC1).
 *
 * A `PreparedTurn` is derived one-per-snapshot-block and Claude Code emits a new
 * assistant block per text segment and per tool call, so before this change one
 * continuous stretch of agent work rendered as N `ASSISTANT` headers with N
 * timestamps. Measured over the 30 most recent local transcripts (2026-08-17,
 * 15,304 assistant blocks): median run 31 blocks, p90 142, max 320.
 *
 * What these pin is the RULE, not the pixel: one header per contiguous
 * same-actor run, the header names the actor rather than the role, and every
 * per-BLOCK signal stays at its block. The last part is the one worth being
 * strict about — hoisting an outcome chip or a turn anchor to the run header
 * would attribute one block's error, or one block's address, to a stretch that
 * can be 320 blocks long.
 *
 * Run via: bun run test:components
 * (`bunfig.toml` ignores `src/cockpit/web/**` globally; that script passes the
 * override, which is why a bare `bun test <path>` here matches nothing.)
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConversationView } from "./ConversationView";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

/** Seconds apart, well under the gap threshold — these must NOT split a run. */
function ts(index: number): string {
  return new Date(Date.UTC(2026, 7, 17, 12, 0, index)).toISOString();
}

function assistantBlock(
  index: number,
  text: string,
  model?: string
): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
    ...(model === undefined ? {} : { model }),
  } as SessionContextSnapshotBlock;
}

function userBlock(index: number, text: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "user-prompt",
    source: "observed",
    content: { role: "user", content: [{ type: "text", text }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "user",
  };
}

function snapshot(blocks: SessionContextSnapshotBlock[]): SessionContextSnapshot {
  return {
    agentSessionId: "conv-run-grouping",
    harness: "claude_code",
    blocks,
    assembledAt: ts(0),
  };
}

function renderCV(blocks: SessionContextSnapshotBlock[]) {
  return render(
    <MemoryRouter>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ConversationView snapshot={snapshot(blocks)} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function runHeaders(): HTMLElement[] {
  return screen.queryAllByTestId("run-header");
}

function actorLabels(): string[] {
  return screen.queryAllByTestId("turn-role-label").map((el) => el.textContent ?? "");
}

const OPUS = "claude-opus-5";
const SONNET = "claude-sonnet-5";

afterEach(cleanup);

describe("conversation thread — actor-run grouping (mt#3845)", () => {
  test("a run of same-model assistant blocks renders ONE header, not one per block", () => {
    renderCV([
      assistantBlock(0, "reading the module", OPUS),
      assistantBlock(1, "still reading", OPUS),
      assistantBlock(2, "found it", OPUS),
      assistantBlock(3, "and fixed it", OPUS),
      assistantBlock(4, "tests pass", OPUS),
    ]);

    expect(runHeaders()).toHaveLength(1);
    // Control: all five blocks DID render, so the count above is grouping and
    // not four blocks going missing.
    for (const text of [
      "reading the module",
      "still reading",
      "found it",
      "and fixed it",
      "tests pass",
    ]) {
      expect(screen.getByText(text)).toBeDefined();
    }
  });

  test("the header names the MODEL TIER — the word 'assistant' is gone", () => {
    renderCV([assistantBlock(0, "hello", OPUS)]);

    expect(actorLabels()).toEqual(["Opus"]);
    expect(document.body.textContent ?? "").not.toContain("assistant");
  });

  test("a dated model id still resolves to its tier — the registry pins one build per tier", () => {
    // The registry's opus row pins `claude-opus-4-8`; every block in the local
    // corpus records `claude-opus-5`. An exact-canonicalId lookup renders the
    // raw id here, which is the defect the tier resolver exists to prevent.
    renderCV([assistantBlock(0, "hello", "claude-opus-4-5-20260101")]);

    expect(actorLabels()).toEqual(["Opus"]);
    expect(document.body.textContent ?? "").not.toContain("claude-opus-4-5");
  });

  test("no recorded model renders NO actor claim — never a guessed default", () => {
    // ask#7348's option (a) is explicit: "unknown actor must render as nothing,
    // never a guessed default." The header row itself still renders (it carries
    // the clock); it simply makes no claim about who spoke.
    renderCV([assistantBlock(0, "hello")]);

    expect(runHeaders()).toHaveLength(1);
    expect(actorLabels()).toEqual([]);
  });

  test("a model change SPLITS the run, so the switch is visible", () => {
    renderCV([
      assistantBlock(0, "opus work", OPUS),
      assistantBlock(1, "more opus work", OPUS),
      assistantBlock(2, "sonnet work", SONNET),
      assistantBlock(3, "more sonnet work", SONNET),
    ]);

    expect(runHeaders()).toHaveLength(2);
    expect(actorLabels()).toEqual(["Opus", "Sonnet"]);
  });

  test("an operator turn between two assistant runs splits them", () => {
    renderCV([
      assistantBlock(0, "first answer", OPUS),
      userBlock(1, "follow-up question"),
      assistantBlock(2, "second answer", OPUS),
    ]);

    expect(actorLabels()).toEqual(["Opus", "user", "Opus"]);
  });

  test("the synthetic-retry sentinel gets its own run and keeps its chip", () => {
    // `<synthetic>` is a harness-generated retry, not a model response. It must
    // never render as a model tier, and it must not hide inside a real model's
    // run — both fall out of keying the run on the raw model id.
    renderCV([
      assistantBlock(0, "trying", OPUS),
      assistantBlock(1, "retry filler", "<synthetic>"),
      assistantBlock(2, "recovered", OPUS),
    ]);

    expect(runHeaders()).toHaveLength(3);
    // The middle run resolves no tier, so it carries no label — the retry chip
    // is what identifies it.
    expect(actorLabels()).toEqual(["Opus", "Opus"]);
    expect(screen.getAllByTestId("turn-retrying")).toHaveLength(1);
    expect(document.body.textContent ?? "").not.toContain("<synthetic>");
  });

  test("EVERY block keeps its own turn anchor — addresses resolve per block, not per run", () => {
    // The regression this guards: turn addresses, the addressed-mark ring and
    // film moments all resolve against `data-turn-index`. A run that carried one
    // anchor would land every deep link on the top of a 320-block block.
    const { container } = renderCV([
      assistantBlock(0, "a", OPUS),
      assistantBlock(1, "b", OPUS),
      assistantBlock(2, "c", OPUS),
    ]);

    const anchored = container.querySelectorAll("[data-turn-index]");
    expect(anchored).toHaveLength(3);
    expect(Array.from(anchored).map((el) => el.getAttribute("data-turn-index"))).toEqual([
      "0",
      "1",
      "2",
    ]);
    // ...while still being ONE run.
    expect(runHeaders()).toHaveLength(1);
  });

  test("the chip row is CONDITIONAL — present only on a block that has a chip", () => {
    // Both halves are asserted in one test on purpose. The absence half alone
    // cannot fail against a tree that has no `turn-chips` testid at all — it
    // passed the negative control for exactly that reason, which makes it
    // tautological rather than a check. Pairing it with the presence half means
    // the test can only pass when the conditional actually works.
    renderCV([
      assistantBlock(0, "no chips here", OPUS),
      { ...assistantBlock(1, "retry filler", "<synthetic>") },
      assistantBlock(2, "no chips here either", OPUS),
    ]);

    // Exactly one chip row, on the retry block — not three.
    const chipRows = screen.queryAllByTestId("turn-chips");
    expect(chipRows).toHaveLength(1);
    expect(chipRows[0]!.textContent ?? "").toContain("Retrying");
  });

  test("a day boundary between same-actor blocks splits the run", () => {
    // A separator swallowed into a contiguous actor block would read as that
    // actor's output. Same rule covers rewind markers and compaction boundaries.
    const dayOne = assistantBlock(0, "before midnight", OPUS);
    const dayTwo: SessionContextSnapshotBlock = {
      ...assistantBlock(1, "after midnight", OPUS),
      timestamp: new Date(Date.UTC(2026, 7, 19, 12, 0, 0)).toISOString(),
    };

    renderCV([dayOne, dayTwo]);

    expect(runHeaders()).toHaveLength(2);
  });
});
