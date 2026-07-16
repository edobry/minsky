/**
 * Tests for ConversationOverviewPanel (mt#2792 — conversation Overview tab
 * enrichment). Covers the three acceptance tests from the task spec:
 *   1. A conversation bound to a task shows the task link (entity-linked,
 *      navigable — asserted via its `href`, the repo's established pattern
 *      for entity-link assertions, e.g. ConversationView.errors.test.tsx).
 *   2. A conversation with tool calls shows a nonzero tool breakdown
 *      consistent with a fixture snapshot.
 *   3. A conversation with none of the optional fields still renders cleanly
 *      (no crash, no empty labels — everything absent renders nothing).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConversationOverviewPanel } from "./ConversationOverviewPanel";
import type { ConversationOverviewPayload, WorkspaceOverviewFields } from "./RunDetail";
import type { ConversationId } from "@minsky/domain/ids";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONVERSATION_ID = "agent-overview-panel-test" as ConversationId;

function conversationMeta(
  overrides: Partial<ConversationOverviewPayload["conversationMeta"]> = {}
): ConversationOverviewPayload["conversationMeta"] {
  return {
    cwd: "/Users/edobry/Projects/minsky",
    harness: "claude_code",
    startedAt: "2026-07-14T12:00:00.000Z",
    endedAt: "2026-07-14T12:30:00.000Z",
    turnCount: 4,
    relatedTaskIds: [],
    relatedPrNumbers: [],
    lastActivityAt: null,
    ...overrides,
  };
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

function assistantToolCallBlock(index: number, toolUseId: string, name: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input: {} }] },
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

function mockSnapshot(blocks: SessionContextSnapshotBlock[]) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === "/api/cockpit/context-inspector/snapshot") {
      return Promise.resolve(
        new Response(JSON.stringify({ agentSessionId: CONVERSATION_ID, harness: "claude_code", blocks, assembledAt: ts(999) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

function mockSnapshot404() {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code: "session_not_found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    )
  ) as typeof globalThis.fetch;
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function renderPanel(props: {
  conversationMeta: ConversationOverviewPayload["conversationMeta"];
  workspace: WorkspaceOverviewFields | null;
}) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={createTestQueryClient()}>
        <ConversationOverviewPanel
          agentSessionId={CONVERSATION_ID}
          conversationMeta={props.conversationMeta}
          workspace={props.workspace}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationOverviewPanel — related task link (acceptance test 1)", () => {
  test("a conversation with a related task shows an entity-linked, navigable task link", async () => {
    mockSnapshot([]);
    renderPanel({
      conversationMeta: conversationMeta({ relatedTaskIds: ["mt#2370"] }),
      workspace: null,
    });

    const link = await screen.findByRole("link", { name: "mt#2370" });
    expect(link.getAttribute("href")).toBe("/tasks/mt%232370");
  });

  test("a conversation with a related PR shows an entity-linked changeset link", async () => {
    mockSnapshot([]);
    renderPanel({
      conversationMeta: conversationMeta({ relatedPrNumbers: ["1234"] }),
      workspace: null,
    });

    const link = await screen.findByRole("link", { name: "PR #1234" });
    expect(link.getAttribute("href")).toBe("/changeset/1234");
  });
});

describe("ConversationOverviewPanel — tool breakdown (acceptance test 2)", () => {
  test("shows a nonzero tool breakdown consistent with the fixture snapshot", async () => {
    mockSnapshot([
      userTextBlock(0, "run the tests then check status"),
      assistantToolCallBlock(1, "c1", "Bash"),
      userToolResultBlock(2, "c1", "ok"),
      assistantToolCallBlock(3, "c2", "Bash"),
      userToolResultBlock(4, "c2", "ok"),
      assistantToolCallBlock(5, "c3", "mcp__minsky__tasks_get"),
      userToolResultBlock(6, "c3", "not found", true),
    ]);
    renderPanel({ conversationMeta: conversationMeta(), workspace: null });

    await waitFor(() => expect(screen.getByText("3 tool calls")).toBeDefined());
    expect(screen.getByText("1 error")).toBeDefined();
    // Breakdown lines: Bash x2, minsky · tasks_get x1.
    expect(screen.getByText("Bash")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("minsky · tasks_get")).toBeDefined();
  });

  test("shows the last-assistant-message snippet when present", async () => {
    mockSnapshot([
      userTextBlock(0, "hello"),
      {
        id: "block-1",
        type: "assistant-text",
        source: "observed",
        content: { role: "assistant", content: [{ type: "text", text: "Here is the final answer." }] },
        timestamp: ts(1),
        turnIndex: 1,
        rawJsonlType: "assistant",
      },
    ]);
    renderPanel({ conversationMeta: conversationMeta(), workspace: null });

    expect(await screen.findByText("Last assistant message")).toBeDefined();
    expect(screen.getByText("Here is the final answer.")).toBeDefined();
  });
});

describe("ConversationOverviewPanel — all-optional-fields-absent (acceptance test 3)", () => {
  test("renders cleanly with no crash and no empty labels when nothing is derivable", async () => {
    mockSnapshot404();
    const { container } = renderPanel({
      conversationMeta: conversationMeta({ startedAt: null, endedAt: null }),
      workspace: null,
    });

    // Give the snapshot query a tick to settle into its error state.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    expect(screen.queryByText("Workspace")).toBeNull();
    expect(screen.queryByText("Duration")).toBeNull();
    expect(screen.queryByText("Related")).toBeNull();
    expect(screen.queryByText("Tool activity")).toBeNull();
    expect(screen.queryByText("Last assistant message")).toBeNull();
    expect(screen.queryByText("First user prompt")).toBeNull();
    // No stray "—" placeholder text anywhere in the panel.
    expect(container.textContent).not.toContain("—");
  });

  test("computes duration from startedAt -> endedAt when both are present", () => {
    mockSnapshot404();
    renderPanel({
      conversationMeta: conversationMeta({
        startedAt: "2026-07-14T12:00:00.000Z",
        endedAt: "2026-07-14T12:05:00.000Z",
      }),
      workspace: null,
    });
    expect(screen.getByText("Duration")).toBeDefined();
    expect(screen.getByText("5m")).toBeDefined();
  });

  test("shows a workspace link when a workspace is bound", () => {
    mockSnapshot404();
    const workspace: WorkspaceOverviewFields = {
      session: {
        sessionId: "577bbf25-90e5-4229-bc6a-60bcd4083b38",
        taskId: "mt#100",
        taskTitle: "Example task",
        status: "IN-PROGRESS",
        liveness: "healthy",
        agentId: null,
        branch: "task/mt-100",
        repoName: null,
        repoUrl: null,
        createdAt: null,
        lastActivityAt: null,
        lastCommitHash: null,
        lastCommitMessage: null,
        commitCount: null,
      },
      commits: [],
      pr: null,
    };
    renderPanel({ conversationMeta: conversationMeta(), workspace });

    const link = screen.getByRole("link", { name: /577bbf25/ });
    expect(link.getAttribute("href")).toBe("/agents/577bbf25-90e5-4229-bc6a-60bcd4083b38");
  });
});
