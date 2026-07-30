/**
 * ConversationView rewound-branch suppression tests (mt#3323).
 *
 * A superseded operator prompt (the operator re-dictated or edited it) stays in
 * the transcript as a sibling branch and used to render as an ordinary turn —
 * showing prose the agent never received. Blocks are marked upstream by
 * `markAbandonedRewindBranches`; this surface hides them and reports the count.
 *
 * These tests feed synthetic snapshots through the public `{ snapshot }` prop
 * (the layout-agnostic path), mirroring ConversationView.windowing.test.tsx.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
    <QueryClientProvider client={createTestQueryClient()}>
      <ConversationView snapshot={snapshot} />
    </QueryClientProvider>
  );
}

function turnBlock(
  i: number,
  role: "user" | "assistant",
  body: string,
  extra: Partial<SessionContextSnapshotBlock> = {}
): SessionContextSnapshotBlock {
  return {
    id: `block-${i}`,
    type: role === "user" ? "user-prompt" : "assistant-text",
    source: "observed",
    content: { role, content: body },
    timestamp: new Date(Date.UTC(2026, 6, 29, 16, 0, i)).toISOString(),
    turnIndex: i,
    rawJsonlType: role,
    ...extra,
  };
}

function snapshotOf(blocks: SessionContextSnapshotBlock[]): SessionContextSnapshot {
  return {
    agentSessionId: "test-session",
    harness: "claude_code",
    blocks,
    assembledAt: new Date(Date.UTC(2026, 6, 29, 17, 0, 0)).toISOString(),
  };
}

afterEach(cleanup);

describe("ConversationView — rewound branches", () => {
  test("hides a superseded prompt and renders the live one", () => {
    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "SUPERSEDED DRAFT", { isAbandonedBranch: true }),
        turnBlock(2, "user", "LIVE DRAFT"),
        turnBlock(3, "assistant", "answering the live one"),
      ])
    );

    expect(screen.queryByText(/SUPERSEDED DRAFT/)).toBeNull();
    expect(screen.getByText(/LIVE DRAFT/)).toBeTruthy();
    expect(screen.getByText(/answering the live one/)).toBeTruthy();
  });

  test("reports the suppression instead of hiding silently", () => {
    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "SUPERSEDED DRAFT", { isAbandonedBranch: true }),
        turnBlock(2, "user", "LIVE DRAFT"),
      ])
    );

    const notice = screen.getByTestId("rewound-branch-notice");
    expect(notice.textContent).toContain("1 superseded message hidden");
  });

  test("counts superseded PROMPTS, not the attachment blocks dragged along with them", () => {
    const attachment: SessionContextSnapshotBlock = {
      id: "block-attach",
      type: "deferred-tool-catalog",
      source: "observed",
      content: { note: "catalog" },
      timestamp: new Date(Date.UTC(2026, 6, 29, 16, 0, 1)).toISOString(),
      rawJsonlType: "attachment",
      isAbandonedBranch: true,
    };

    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "SUPERSEDED DRAFT", { isAbandonedBranch: true }),
        attachment,
        turnBlock(2, "user", "LIVE DRAFT"),
      ])
    );

    // Two blocks are hidden, but only ONE of them is a message.
    expect(screen.getByTestId("rewound-branch-notice").textContent).toContain(
      "1 superseded message hidden"
    );
  });

  test("pluralizes across multiple rewinds", () => {
    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "FIRST SUPERSEDED", { isAbandonedBranch: true }),
        turnBlock(2, "user", "FIRST LIVE"),
        turnBlock(3, "assistant", "ok"),
        turnBlock(4, "user", "SECOND SUPERSEDED", { isAbandonedBranch: true }),
        turnBlock(5, "user", "SECOND LIVE"),
      ])
    );

    expect(screen.getByTestId("rewound-branch-notice").textContent).toContain(
      "2 superseded messages hidden"
    );
    expect(screen.queryByText(/FIRST SUPERSEDED/)).toBeNull();
    expect(screen.queryByText(/SECOND SUPERSEDED/)).toBeNull();
  });

  test("a conversation with no rewind renders no notice and drops nothing", () => {
    renderCV(
      snapshotOf([
        turnBlock(0, "user", "just one prompt"),
        turnBlock(1, "assistant", "just one answer"),
      ])
    );

    expect(screen.queryByTestId("rewound-branch-notice")).toBeNull();
    expect(screen.getByText(/just one prompt/)).toBeTruthy();
    expect(screen.getByText(/just one answer/)).toBeTruthy();
  });

  test("does not count tool-result lines from an abandoned attempt as superseded messages", () => {
    // The operator rewound AFTER the agent started working, so the abandoned
    // branch carries a tool_result — which is a `user` JSONL line. Counting on
    // rawJsonlType alone would report 2 superseded messages instead of 1
    // (PR #2419 R1 BLOCKING).
    const abandonedToolResult: SessionContextSnapshotBlock = {
      id: "block-tool-result",
      type: "user-prompt",
      source: "observed",
      content: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "A", content: "ok" }],
      },
      timestamp: new Date(Date.UTC(2026, 6, 29, 16, 0, 2)).toISOString(),
      rawJsonlType: "user",
      isAbandonedBranch: true,
    };

    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "SUPERSEDED DRAFT", { isAbandonedBranch: true }),
        abandonedToolResult,
        turnBlock(3, "user", "LIVE DRAFT"),
        turnBlock(4, "assistant", "answering the live one"),
      ])
    );

    expect(screen.getByTestId("rewound-branch-notice").textContent).toContain(
      "1 superseded message hidden"
    );
    expect(screen.queryByText(/SUPERSEDED DRAFT/)).toBeNull();
  });
});
