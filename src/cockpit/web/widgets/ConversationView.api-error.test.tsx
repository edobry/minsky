/**
 * ConversationView API-error text-turn styling tests (mt#2793).
 *
 * Harness-emitted failure text ("API Error: Connection closed mid-response.")
 * sometimes lands as an ordinary assistant text turn instead of a tool-result
 * error and reads identically to normal prose. This gives it destructive-toned
 * treatment when the turn's TRIMMED text starts with "API Error:" — an anchored
 * prefix match, not a substring match anywhere in the turn.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConversationView } from "./ConversationView";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderCV(snapshot: SessionContextSnapshot) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={createTestQueryClient()}>
        <ConversationView snapshot={snapshot} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function ts(index: number): string {
  return new Date(Date.UTC(2026, 6, 14, 12, 0, index)).toISOString();
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

function snapshotWithBlocks(blocks: SessionContextSnapshotBlock[]): SessionContextSnapshot {
  return {
    agentSessionId: "agent-api-error-test",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-07-14T12:00:00.000Z",
  };
}

describe("ConversationView — API-error text styling (mt#2793)", () => {
  afterEach(cleanup);

  test("a turn starting with 'API Error:' renders with destructive-toned treatment", () => {
    const { container } = renderCV(
      snapshotWithBlocks([assistantTextBlock(0, "API Error: Connection closed mid-response.")])
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("API Error: Connection closed mid-response.");
    expect(container.querySelector(".text-destructive")).not.toBeNull();
  });

  test("prose that merely mentions 'API Error' mid-sentence stays unstyled", () => {
    const { container } = renderCV(
      snapshotWithBlocks([assistantTextBlock(0, "The API Error was resolved after a retry.")])
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("The API Error was resolved after a retry.");
  });

  test("leading whitespace before the prefix is still detected (trimmed match)", () => {
    const { container } = renderCV(
      snapshotWithBlocks([assistantTextBlock(0, "  API Error: timeout")])
    );
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  test("ordinary prose has no destructive styling and no alert role", () => {
    const { container } = renderCV(snapshotWithBlocks([assistantTextBlock(0, "All good here.")]));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".text-destructive")).toBeNull();
  });
});
