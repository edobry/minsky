/**
 * ConversationView rewound-branch tests (mt#3323, repositioned by mt#3361).
 *
 * A superseded operator prompt (the operator re-dictated or edited it) stays in
 * the transcript as a sibling branch and used to render as an ordinary turn —
 * showing prose the agent never received. Blocks are marked upstream by
 * `markAbandonedRewindBranches`; this surface hides them.
 *
 * mt#3323 reported the suppression as ONE tally at the top of the view. mt#3361
 * replaced that with a marker at each rewind's own position, expandable to
 * recover the abandoned text — so these tests assert PLACEMENT and RECOVERY,
 * not a count.
 *
 * These tests feed synthetic snapshots through the public `{ snapshot }` prop
 * (the layout-agnostic path), mirroring ConversationView.windowing.test.tsx.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

/** Expand a collapsed marker by clicking its toggle. */
function expandMarker(marker: HTMLElement): void {
  const toggle = marker.querySelector("button");
  if (toggle === null) throw new Error("marker has no toggle button");
  fireEvent.click(toggle);
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

    // Hidden as a TURN — recoverable only by expanding the marker, which this
    // test does not do.
    expect(screen.queryByText(/SUPERSEDED DRAFT/)).toBeNull();
    expect(screen.getByText(/LIVE DRAFT/)).toBeTruthy();
    expect(screen.getByText(/answering the live one/)).toBeTruthy();
  });

  test("marks the rewind inline, immediately before the prompt that replaced it", () => {
    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "SUPERSEDED DRAFT", { isAbandonedBranch: true }),
        turnBlock(2, "user", "LIVE DRAFT"),
      ])
    );

    const marker = screen.getByTestId("superseded-prompt-marker");
    expect(marker.textContent).toContain("1 superseded message");
    // The positional claim: the marker's immediate next sibling is the live
    // turn that replaced the abandoned one.
    expect(marker.nextElementSibling?.textContent).toContain("LIVE DRAFT");
  });

  test("renders no global tally — the mt#3323 notice is gone", () => {
    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "SUPERSEDED DRAFT", { isAbandonedBranch: true }),
        turnBlock(2, "user", "LIVE DRAFT"),
      ])
    );

    expect(screen.queryByTestId("rewound-branch-notice")).toBeNull();
  });

  test("renders one marker per rewind, each at its own position", () => {
    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "FIRST SUPERSEDED", { isAbandonedBranch: true }),
        turnBlock(2, "user", "FIRST LIVE"),
        turnBlock(3, "assistant", "middle answer"),
        turnBlock(4, "user", "SECOND SUPERSEDED", { isAbandonedBranch: true }),
        turnBlock(5, "user", "SECOND LIVE"),
      ])
    );

    const markers = screen.getAllByTestId("superseded-prompt-marker");
    expect(markers).toHaveLength(2);
    // Each marker sits with ITS OWN replacement, not pooled at the top — the
    // whole point of mt#3361, since the two rewinds can be hundreds of turns
    // apart.
    expect(markers[0]?.nextElementSibling?.textContent).toContain("FIRST LIVE");
    expect(markers[1]?.nextElementSibling?.textContent).toContain("SECOND LIVE");

    expect(screen.queryByText(/FIRST SUPERSEDED/)).toBeNull();
    expect(screen.queryByText(/SECOND SUPERSEDED/)).toBeNull();
  });

  test("stays adjacent to its prompt when the rewind straddles a day boundary", () => {
    // Caught in the live cockpit, not by the synthetic cases above: those put
    // every block seconds apart, so no day separator is ever emitted between
    // the marker and its prompt. With a real boundary the marker rendered as
    // marker → "Thu, Jul 30" → prompt, reading as though it belonged to the
    // turn BEFORE the boundary.
    const nextDay = new Date(Date.UTC(2026, 6, 30, 9, 0, 0)).toISOString();

    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "SUPERSEDED DRAFT", {
          isAbandonedBranch: true,
          timestamp: nextDay,
        }),
        turnBlock(2, "user", "LIVE DRAFT", { timestamp: nextDay }),
      ])
    );

    expect(screen.getByTestId("turn-day-divider")).toBeTruthy();
    const marker = screen.getByTestId("superseded-prompt-marker");
    // The separator sorts ABOVE the marker; the marker still touches its prompt.
    expect(marker.nextElementSibling?.textContent).toContain("LIVE DRAFT");
    expect(marker.previousElementSibling?.getAttribute("data-testid")).toBe("turn-day-divider");
  });

  test("is collapsed by default and reveals the superseded text on click", () => {
    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "SUPERSEDED DRAFT", { isAbandonedBranch: true }),
        turnBlock(2, "user", "LIVE DRAFT"),
      ])
    );

    const marker = screen.getByTestId("superseded-prompt-marker");
    expect(screen.queryByTestId("superseded-prompt-text")).toBeNull();
    expect(marker.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");

    expandMarker(marker);

    const revealed = screen.getByTestId("superseded-prompt-text");
    expect(revealed.textContent).toContain("SUPERSEDED DRAFT");
    expect(marker.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
  });

  test("labels the expanded text so it cannot be read as a turn the agent received", () => {
    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "SUPERSEDED DRAFT", { isAbandonedBranch: true }),
        turnBlock(2, "user", "LIVE DRAFT"),
      ])
    );

    expandMarker(screen.getByTestId("superseded-prompt-marker"));

    expect(screen.getByTestId("superseded-prompt-text").textContent).toContain(
      "the agent never received this"
    );
  });

  test("collapses again on a second click", () => {
    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "SUPERSEDED DRAFT", { isAbandonedBranch: true }),
        turnBlock(2, "user", "LIVE DRAFT"),
      ])
    );

    const marker = screen.getByTestId("superseded-prompt-marker");
    expandMarker(marker);
    expect(screen.getByTestId("superseded-prompt-text")).toBeTruthy();

    expandMarker(marker);
    expect(screen.queryByTestId("superseded-prompt-text")).toBeNull();
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
    expect(screen.getByTestId("superseded-prompt-marker").textContent).toContain(
      "1 superseded message"
    );
  });

  test("does not count tool-result lines from an abandoned attempt as superseded messages", () => {
    // The operator rewound AFTER the agent started working, so the abandoned
    // branch carries a tool_result — which is a `user` JSONL line. Counting on
    // rawJsonlType alone would report 2 superseded messages instead of 1
    // (PR #2419 R1 BLOCKING). mt#3361 must not regress this.
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

    const marker = screen.getByTestId("superseded-prompt-marker");
    expect(marker.textContent).toContain("1 superseded message");
    expect(screen.queryByText(/SUPERSEDED DRAFT/)).toBeNull();
  });

  test("groups consecutive superseded prompts into one marker naming both", () => {
    // Two rewinds with no live turn between them share a position, so they
    // share a marker rather than stacking two markers that mean the same place.
    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "FIRST DRAFT", { isAbandonedBranch: true }),
        turnBlock(2, "user", "SECOND DRAFT", { isAbandonedBranch: true }),
        turnBlock(3, "user", "LIVE DRAFT"),
      ])
    );

    const markers = screen.getAllByTestId("superseded-prompt-marker");
    expect(markers).toHaveLength(1);
    expect(markers[0]?.textContent).toContain("2 superseded messages");

    expandMarker(markers[0]!);
    const revealed = screen.getByTestId("superseded-prompt-text");
    expect(revealed.textContent).toContain("FIRST DRAFT");
    expect(revealed.textContent).toContain("SECOND DRAFT");
  });

  test("renders a marker for a rewind with no live turn after it", () => {
    // The operator rewound and has not yet sent the replacement — there is no
    // anchor turn, so the marker lands at the end rather than vanishing.
    renderCV(
      snapshotOf([
        turnBlock(0, "assistant", "go ahead"),
        turnBlock(1, "user", "LIVE DRAFT"),
        turnBlock(2, "user", "ABANDONED TAIL", { isAbandonedBranch: true }),
      ])
    );

    const marker = screen.getByTestId("superseded-prompt-marker");
    expandMarker(marker);
    expect(screen.getByTestId("superseded-prompt-text").textContent).toContain("ABANDONED TAIL");
  });

  test("a conversation with no rewind renders no marker and drops nothing", () => {
    renderCV(
      snapshotOf([
        turnBlock(0, "user", "just one prompt"),
        turnBlock(1, "assistant", "just one answer"),
      ])
    );

    expect(screen.queryByTestId("superseded-prompt-marker")).toBeNull();
    expect(screen.queryByTestId("rewound-branch-notice")).toBeNull();
    expect(screen.getByText(/just one prompt/)).toBeTruthy();
    expect(screen.getByText(/just one answer/)).toBeTruthy();
  });
});
