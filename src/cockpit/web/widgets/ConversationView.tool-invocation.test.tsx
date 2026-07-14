/**
 * ConversationView unified tool-invocation block tests (mt#2790).
 *
 * Verifies the turn-assembly pairing pass: a tool-call + matching tool-result
 * merge into ONE collapsed block (never rendering the result under a USER
 * role label), errors default expanded with destructive styling, orphaned
 * results (no matching call) keep the pre-redesign standalone fallback, and
 * the view-level expand-all/collapse-all controls work.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

function userTextBlock(index: number, text: string): SessionContextSnapshotBlock {
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

function assistantToolCallBlock(
  index: number,
  toolUseId: string,
  name: string,
  input: unknown
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

const LONG_COMMAND =
  "git log --oneline -n 500 --format='%H %s' -- src/very/long/path/to/a/file/that/is/quite/deep/indeed.ts UNIQUE_TAIL_MARKER";

function snapshotWithBlocks(blocks: SessionContextSnapshotBlock[]): SessionContextSnapshot {
  return {
    agentSessionId: "agent-tool-invocation-test",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-07-14T12:00:00.000Z",
  };
}

describe("ConversationView — unified tool-invocation block (mt#2790)", () => {
  afterEach(cleanup);

  test("a call+result pair renders as ONE collapsed block, not two turn-level blocks", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        userTextBlock(0, "please check task mt#2751"),
        assistantToolCallBlock(1, "call-1", "Bash", { command: LONG_COMMAND }),
        userToolResultBlock(2, "call-1", "abc123 fix\ndef456 feat"),
      ])
    );

    // Exactly one merged block (one toggle button), not a separate call block
    // plus a separate result block.
    const toggles = container.querySelectorAll('button[aria-expanded]');
    expect(toggles).toHaveLength(1);

    // Collapsed by default: the truncated command shows, the full/raw
    // payload (which would carry the tail marker) does not.
    expect(screen.getByText(/git log --oneline/)).toBeDefined();
    expect(screen.queryByText(/UNIQUE_TAIL_MARKER/)).toBeNull();
    // Summary line is a digest string, not raw JSON.
    const digest = toggles[0]?.textContent ?? "";
    expect(digest).not.toContain("{");
    expect(digest).not.toContain('"command"');
  });

  test("no tool result renders under a USER role label when paired", () => {
    renderCV(
      snapshotWithBlocks([
        userTextBlock(0, "please check task mt#2751"),
        assistantToolCallBlock(1, "call-1", "Bash", { command: "echo hi" }),
        userToolResultBlock(2, "call-1", "hi"),
      ])
    );
    // Only the genuine user text turn carries the "user" role label — the
    // tool-result's own turn (2) contributed nothing (fully consumed by
    // pairing) and must not render at all.
    expect(screen.getAllByText("user")).toHaveLength(1);
  });

  test("expanding the block reveals the full args + result via ToolPayload", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        assistantToolCallBlock(0, "call-1", "Bash", { command: LONG_COMMAND }),
        userToolResultBlock(1, "call-1", "abc123 fix\ndef456 feat"),
      ])
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(/UNIQUE_TAIL_MARKER/)).toBeDefined();
    expect(container.textContent).toContain("abc123 fix");
    expect(container.textContent).toContain("def456 feat");
  });

  test("a tool error is visually distinct and expanded by default (not collapsed into an ok-looking line)", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        assistantToolCallBlock(0, "call-err", "mcp__minsky__tasks_get", { taskId: "mt#9999" }),
        userToolResultBlock(1, "call-err", "task not found", true),
      ])
    );
    const toggle = container.querySelector('button[aria-expanded]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    // Full result body is already visible without an extra click.
    expect(screen.getByText("task not found")).toBeDefined();
    expect(container.querySelector(".border-destructive\\/50")).not.toBeNull();
  });

  test("an orphaned result (no matching call in the rendered set) still renders standalone, no crash", () => {
    const { container } = renderCV(
      snapshotWithBlocks([userToolResultBlock(0, "call-nowhere", "orphan payload")])
    );
    expect(screen.getByText("tool result")).toBeDefined();
    expect(screen.getByText("orphan payload")).toBeDefined();
    // Standalone fallback, not the merged toggle block.
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
  });

  test("expand all / collapse all works across every block", () => {
    renderCV(
      snapshotWithBlocks([
        assistantToolCallBlock(0, "call-1", "Bash", { command: "echo one" }),
        userToolResultBlock(1, "call-1", "one"),
        assistantToolCallBlock(2, "call-2", "Bash", { command: "echo two" }),
        userToolResultBlock(3, "call-2", "two"),
      ])
    );

    // Both start collapsed.
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(2);

    fireEvent.click(screen.getByText("Expand all"));
    expect(screen.getAllByRole("button", { expanded: true })).toHaveLength(2);
    expect(screen.getByText("one")).toBeDefined();
    expect(screen.getByText("two")).toBeDefined();

    fireEvent.click(screen.getByText("Collapse all"));
    expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(2);
    expect(screen.queryByText("one")).toBeNull();

    // Per-block toggle still works after a broadcast.
    fireEvent.click(screen.getAllByRole("button", { expanded: false })[0]!);
    expect(screen.getAllByRole("button", { expanded: true })).toHaveLength(1);
  });

  test("a subagent-spawn call still shows the → subagent badge on the merged block", () => {
    // Note: the turn header already carries its own spawn badge
    // (`turn.isSpawnBoundary`, pre-existing) IN ADDITION to the new
    // block-level badge on the merged ToolInvocation — so at least one
    // match is expected, not necessarily exactly one.
    renderCV(
      snapshotWithBlocks([
        assistantToolCallBlock(0, "call-spawn", "Agent", { subagent_type: "Explore" }),
        userToolResultBlock(1, "call-spawn", "done"),
      ])
    );
    expect(screen.getAllByText(/subagent \(Explore\)/).length).toBeGreaterThanOrEqual(1);
  });
});
