/**
 * ConversationView tail-first windowing tests (mt#2433).
 *
 * Long transcripts were eagerly mounted in full (265 blocks / ~1MB → >20s to
 * first content); the window renders only the most recent INITIAL_TURNS turns
 * with chunked "Show older" expansion. These tests feed synthetic snapshots
 * through the public `{ snapshot }` prop (the layout-agnostic path).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ConversationView } from "./ConversationView";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

function turnBlock(i: number, role: "user" | "assistant"): SessionContextSnapshotBlock {
  return {
    id: `block-${i}`,
    type: role === "user" ? "user-prompt" : "assistant-text",
    source: "observed",
    content: { role, content: `turn-${i} body` },
    timestamp: new Date(Date.UTC(2026, 5, 10, 12, 0, i)).toISOString(),
    turnIndex: i,
    rawJsonlType: role,
  };
}

function syntheticSnapshot(turnCount: number): SessionContextSnapshot {
  const blocks: SessionContextSnapshotBlock[] = [];
  for (let i = 0; i < turnCount; i++) {
    blocks.push(turnBlock(i, i % 2 === 0 ? "user" : "assistant"));
  }
  return {
    agentSessionId: "agent-test-windowing",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-06-10T12:00:00.000Z",
  };
}

describe("ConversationView tail-first windowing (mt#2433)", () => {
  afterEach(cleanup);

  test("small transcript renders fully with no windowing control", () => {
    render(<ConversationView snapshot={syntheticSnapshot(10)} />);
    expect(screen.getByText("turn-0 body")).toBeDefined();
    expect(screen.getByText("turn-9 body")).toBeDefined();
    expect(screen.queryByText(/Show older/)).toBeNull();
  });

  test("large transcript renders only the tail window initially", () => {
    render(<ConversationView snapshot={syntheticSnapshot(120)} />);
    // Newest turns are rendered…
    expect(screen.getByText("turn-119 body")).toBeDefined();
    expect(screen.getByText("turn-70 body")).toBeDefined();
    // …oldest are not (120 - 50 = 70 hidden: turns 0..69).
    expect(screen.queryByText("turn-0 body")).toBeNull();
    expect(screen.queryByText("turn-69 body")).toBeNull();
    expect(screen.getByText("Show older (70 more)")).toBeDefined();
  });

  test("Show older reveals an additional chunk", () => {
    render(<ConversationView snapshot={syntheticSnapshot(120)} />);
    fireEvent.click(screen.getByText("Show older (70 more)"));
    // 50 + 100 > 120 → everything is now visible and the control disappears.
    expect(screen.getByText("turn-0 body")).toBeDefined();
    expect(screen.queryByText(/Show older/)).toBeNull();
  });

  test("Show all reveals the entire transcript", () => {
    render(<ConversationView snapshot={syntheticSnapshot(300)} />);
    expect(screen.queryByText("turn-0 body")).toBeNull();
    fireEvent.click(screen.getByText("Show all"));
    expect(screen.getByText("turn-0 body")).toBeDefined();
    expect(screen.queryByText(/Show older/)).toBeNull();
  });

  test("chunked expansion decrements the hidden count", () => {
    render(<ConversationView snapshot={syntheticSnapshot(300)} />);
    // 300 - 50 = 250 hidden initially.
    fireEvent.click(screen.getByText("Show older (250 more)"));
    // +100 → 150 hidden.
    expect(screen.getByText("Show older (150 more)")).toBeDefined();
    expect(screen.getByText("turn-150 body")).toBeDefined();
    expect(screen.queryByText("turn-149 body")).toBeNull();
  });
});
