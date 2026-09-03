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

function renderDriven(
  drivenSessionId: string,
  drivenBlocks: SessionContextSnapshotBlock[],
  opts?: { harnessKind?: string | null; authMode?: string | null }
) {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ConversationView
        drivenSessionId={drivenSessionId}
        drivenBlocks={drivenBlocks}
        harnessKind={opts?.harnessKind}
        authMode={opts?.authMode}
      />
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

  test("shared code path: ConversationThread's tail-first windowing (mt#2433) applies identically to driven blocks", async () => {
    const blocks = Array.from({ length: 120 }, (_, i) => assistantBlock(i, `driven-turn-${i}`));
    renderDriven("driven-windowed", blocks);

    // Same windowing behavior as ConversationView.windowing.test.tsx's DB-snapshot
    // case: newest 50 turns visible, oldest 70 hidden behind the start boundary.
    expect(screen.getByText("driven-turn-119")).toBeDefined();
    expect(screen.getByText("driven-turn-70")).toBeDefined();
    expect(screen.queryByText("driven-turn-0")).toBeNull();
    expect(screen.getByTestId("thread-hidden-above").textContent).toContain("70 earlier turns");

    fireEvent.click(screen.getByText("show more"));
    // AWAITED, not asserted synchronously: the reveal runs inside a React
    // transition (mt#3688), so it is asynchronous by construction.
    await screen.findByText("driven-turn-0");
    // Revealing to the start replaces the boundary with the beginning marker
    // rather than leaving blank space (mt#3688).
    expect(screen.getByTestId("thread-start")).toBeDefined();
  });
});

describe("ConversationView — driven-session record header (mt#4935)", () => {
  afterEach(cleanup);

  test("renders 'harnessKind · authMode' when both are provided", () => {
    renderDriven("driven-header-1", [], { harnessKind: "claude-code", authMode: "subscription" });
    expect(screen.getByText("claude-code · subscription")).toBeDefined();
  });

  test("renders nothing when both are null (registry read not yet resolved)", () => {
    renderDriven("driven-header-2", [], { harnessKind: null, authMode: null });
    expect(screen.queryByText(/claude-code|subscription|api-key/)).toBeNull();
  });

  test("renders the harnessKind alone when authMode is null", () => {
    renderDriven("driven-header-3", [], { harnessKind: "codex", authMode: null });
    expect(screen.getByText("codex")).toBeDefined();
  });
});
