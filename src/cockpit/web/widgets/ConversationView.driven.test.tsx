/**
 * ConversationView driven-session variant tests (mt#2751, Rung 2B).
 *
 * Verifies the `drivenSessionId`/`drivenBlocks` prop variant renders through
 * the SAME `ConversationThread` renderer as the two DB-snapshot variants
 * (`snapshot`, `sessionId`) — mt#2751 success criterion 2 ("the display
 * component is shared with Rung 1... verified by shared code path"). Proven
 * two ways: (a) code inspection is trivial by construction — only one
 * `ConversationThread` function exists in this file, and `DrivenSessionThread`
 * calls it directly; (b) behaviorally, by showing that `ConversationThread`-only
 * logic (tail-first windowing, per mt#2433) applies identically to driven
 * blocks fed via the `drivenBlocks` seam.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { ConversationView } from "./ConversationView";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderDriven(drivenSessionId: string, drivenBlocks: SessionContextSnapshotBlock[]) {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ConversationView drivenSessionId={drivenSessionId} drivenBlocks={drivenBlocks} />
    </QueryClientProvider>
  );
}

function assistantBlock(i: number, text: string): SessionContextSnapshotBlock {
  return {
    id: `driven:turn:${i}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: new Date(Date.UTC(2026, 6, 13, 12, 0, i)).toISOString(),
    rawJsonlType: "assistant",
  };
}

describe("ConversationView — driven-session variant (mt#2751)", () => {
  afterEach(cleanup);

  test("renders driven blocks via the shared thread renderer", () => {
    renderDriven("driven-1", [assistantBlock(0, "hello from the driven session")]);
    expect(screen.getByText("hello from the driven session")).toBeDefined();
  });

  test("empty blocks render the shared 'no conversational turns' placeholder — same as an empty DB snapshot", () => {
    renderDriven("driven-empty", []);
    expect(screen.getByText("This session has no conversational turns to display.")).toBeDefined();
  });

  test("a growing blocks array (simulating streaming re-renders) updates the SAME rendered turn in place", () => {
    const { rerender } = render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ConversationView drivenSessionId="driven-grow" drivenBlocks={[assistantBlock(0, "Hel")]} />
      </QueryClientProvider>
    );
    expect(screen.getByText("Hel")).toBeDefined();

    rerender(
      <QueryClientProvider client={createTestQueryClient()}>
        <ConversationView drivenSessionId="driven-grow" drivenBlocks={[assistantBlock(0, "Hello")]} />
      </QueryClientProvider>
    );
    expect(screen.queryByText("Hel")).toBeNull();
    expect(screen.getByText("Hello")).toBeDefined();
  });

  test("shared code path: ConversationThread's tail-first windowing (mt#2433) applies identically to driven blocks", () => {
    const blocks = Array.from({ length: 120 }, (_, i) => assistantBlock(i, `driven-turn-${i}`));
    renderDriven("driven-windowed", blocks);

    // Same windowing behavior as ConversationView.windowing.test.tsx's DB-snapshot
    // case: newest 50 turns visible, oldest 70 hidden behind "Show older".
    expect(screen.getByText("driven-turn-119")).toBeDefined();
    expect(screen.getByText("driven-turn-70")).toBeDefined();
    expect(screen.queryByText("driven-turn-0")).toBeNull();
    expect(screen.getByText("Show older (70 more)")).toBeDefined();

    fireEvent.click(screen.getByText("Show older (70 more)"));
    expect(screen.getByText("driven-turn-0")).toBeDefined();
  });
});
