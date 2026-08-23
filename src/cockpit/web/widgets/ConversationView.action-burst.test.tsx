/**
 * Action-burst fold render tests (mt#4250).
 *
 * The grouping RULE is asserted directly against the pure pass in
 * `lib/conversation-action-bursts.test.ts`. What is asserted HERE is the thing
 * only a render can answer: that a fold genuinely removes its rows from the
 * DOM, and that opening it gives every one of them back. A grouping function
 * that returns the right shape while the component renders the turns anyway
 * would pass every test in the other file.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConversationView } from "./ConversationView";
import type { TurnAddress } from "../lib/conversation-turn-address";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderCV(snapshot: SessionContextSnapshot, turnTarget?: TurnAddress) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={createTestQueryClient()}>
        <ConversationView snapshot={snapshot} turnTarget={turnTarget} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function ts(index: number): string {
  return new Date(Date.UTC(2026, 7, 18, 12, 0, index)).toISOString();
}

function assistantTextBlock(index: number, text: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function assistantToolCallBlock(
  index: number,
  toolUseId: string,
  name: string,
  input: unknown = {}
): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function userToolResultBlock(
  index: number,
  toolUseId: string,
  content: unknown,
  isError = false
): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "user-prompt",
    source: "observed",
    content: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "user",
  };
}

function snapshotWithBlocks(blocks: SessionContextSnapshotBlock[]): SessionContextSnapshot {
  return {
    agentSessionId: "agent-action-burst-test",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-08-18T12:00:00.000Z",
  };
}

/** Every tool row currently in the DOM, by its `tool_use` id. */
function renderedToolIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-tool-use-id]")).map(
    (el) => el.getAttribute("data-tool-use-id") ?? ""
  );
}

/**
 * prose → six tool calls → prose. The canonical shape this feature exists for:
 * a stretch of machinery separating two things the reader wants to read.
 */
const SIX_CALLS = ["c1", "c2", "c3", "c4", "c5", "c6"];

function sixCallSnapshot(): SessionContextSnapshot {
  const blocks: SessionContextSnapshotBlock[] = [assistantTextBlock(0, "Starting the sweep.")];
  let index = 1;
  for (const id of SIX_CALLS) {
    blocks.push(assistantToolCallBlock(index, id, "Read", { file_path: `/tmp/${id}.ts` }));
    index += 1;
    blocks.push(userToolResultBlock(index, id, "ok"));
    index += 1;
  }
  blocks.push(assistantTextBlock(index, "Sweep finished; nothing surprising."));
  return snapshotWithBlocks(blocks);
}

describe("ConversationView — action-burst folding (mt#4250)", () => {
  afterEach(cleanup);

  test("a run of six calls between two speech blocks collapses to one control", () => {
    const { container } = renderCV(sixCallSnapshot());

    expect(screen.getAllByTestId("action-burst-toggle")).toHaveLength(1);
  });

  test("the folded rows are absent from the DOM, not merely hidden by CSS", () => {
    const { container } = renderCV(sixCallSnapshot());

    // The whole density claim rests on this: a `hidden` row still costs the
    // reader nothing visually but proves nothing about what the fold did.
    expect(renderedToolIds(container)).toEqual([]);
  });

  test("expanding gives back every row that was folded, in order", () => {
    const { container } = renderCV(sixCallSnapshot());

    fireEvent.click(screen.getByTestId("action-burst-toggle"));

    expect(renderedToolIds(container)).toEqual(SIX_CALLS);
  });

  test("the speech on either side is never folded", () => {
    renderCV(sixCallSnapshot());

    expect(screen.getByText(/Starting the sweep\./)).toBeDefined();
    expect(screen.getByText(/Sweep finished/)).toBeDefined();
  });

  test("the summary line names what it is standing for", () => {
    renderCV(sixCallSnapshot());

    const toggle = screen.getByTestId("action-burst-toggle");
    expect(toggle.textContent).toContain("read 6 files");
  });

  test("collapsing again re-hides the rows", () => {
    const { container } = renderCV(sixCallSnapshot());

    const toggle = screen.getByTestId("action-burst-toggle");
    fireEvent.click(toggle);
    expect(renderedToolIds(container)).toEqual(SIX_CALLS);

    fireEvent.click(toggle);
    expect(renderedToolIds(container)).toEqual([]);
  });

  test("a failure among healthy calls stays visible while the rest fold", () => {
    const blocks: SessionContextSnapshotBlock[] = [assistantTextBlock(0, "Starting.")];
    let index = 1;
    const ids = ["h1", "h2", "h3", "boom", "h4", "h5", "h6"];
    for (const id of ids) {
      blocks.push(assistantToolCallBlock(index, id, id === "boom" ? "Bash" : "Read"));
      index += 1;
      blocks.push(userToolResultBlock(index, id, id === "boom" ? "failed" : "ok", id === "boom"));
      index += 1;
    }
    const { container } = renderCV(snapshotWithBlocks(blocks));

    // The error row is the ONLY one still rendered; the healthy runs on either
    // side of it folded. A failure can never hide inside a calm summary line.
    expect(renderedToolIds(container)).toEqual(["boom"]);
    expect(screen.getAllByTestId("action-burst-toggle")).toHaveLength(2);
  });

  test("a deep link into a folded call opens the fold on arrival", () => {
    // c3 is the third call, at turnIndex 5 (prose at 0, then call/result pairs).
    // A link landing on a closed fold is the worst version of this feature: the
    // reader asked for one specific action and would be shown a summary of it.
    const { container } = renderCV(sixCallSnapshot(), { turnIndex: 5, toolUseId: "c3" });

    expect(renderedToolIds(container)).toEqual(SIX_CALLS);
    const addressed = container.querySelector<HTMLElement>('[data-tool-use-id="c3"]');
    expect(addressed?.className).toContain("ring-2");
  });

  test("expand all opens folds, collapse all closes them", () => {
    const { container } = renderCV(sixCallSnapshot());

    fireEvent.click(screen.getByText("Expand all"));
    expect(renderedToolIds(container)).toEqual(SIX_CALLS);

    fireEvent.click(screen.getByText("Collapse all"));
    expect(renderedToolIds(container)).toEqual([]);
  });

  test("a run of two does not fold", () => {
    const blocks: SessionContextSnapshotBlock[] = [assistantTextBlock(0, "Starting.")];
    blocks.push(assistantToolCallBlock(1, "t1", "Read"));
    blocks.push(userToolResultBlock(2, "t1", "ok"));
    blocks.push(assistantToolCallBlock(3, "t2", "Read"));
    blocks.push(userToolResultBlock(4, "t2", "ok"));
    blocks.push(assistantTextBlock(5, "Done."));

    const { container } = renderCV(snapshotWithBlocks(blocks));

    expect(screen.queryAllByTestId("action-burst-toggle")).toHaveLength(0);
    expect(renderedToolIds(container)).toEqual(["t1", "t2"]);
  });
});
