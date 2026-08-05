/**
 * ConversationView turn-address landing tests (mt#3791).
 *
 * The session film's expanded rows link to a SPECIFIC action; before this the
 * link carried only a conversation id, so the reader arrived at the newest
 * exchange with no way to find what they clicked. These tests cover the
 * consuming half: resolving the address, mounting a turn the tail-first window
 * left out, marking it, and saying so when it resolves to nothing.
 *
 * What is NOT here: whether the marked element ends up inside the scrollport.
 * That is geometry, and this suite runs under happy-dom, which has no layout
 * engine — `scrollIntoView` is a no-op and every box measures 0 (measured
 * mt#3338). `scripts/verify-conversation-turn-target.ts` asserts the landing
 * over CDP in a real browser. Everything below is state and DOM structure.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConversationView } from "./ConversationView";
import { INITIAL_TURNS } from "../hooks/useThreadWindow";
import {
  TOOL_USE_ANCHOR_ATTR,
  TURN_ANCHOR_ATTR,
  type TurnAddress,
} from "../lib/conversation-turn-address";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

// A router is in scope because a tool call's spawn badge can render a <Link>;
// the QueryClient is for <Prose>'s entity index (empty here, so inert). Mirrors
// ConversationView.tool-invocation.test.tsx's wrapper.
function renderCV(snapshot: SessionContextSnapshot, turnTarget?: TurnAddress) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ConversationView snapshot={snapshot} turnTarget={turnTarget} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function ts(index: number): string {
  return new Date(Date.UTC(2026, 7, 5, 12, 0, index)).toISOString();
}

function textBlock(index: number, role: "user" | "assistant"): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: role === "user" ? "user-prompt" : "assistant-text",
    source: "observed",
    content: { role, content: [{ type: "text", text: `turn-${index} body` }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: role,
  };
}

function toolCallBlock(index: number, toolUseId: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: {
      role: "assistant",
      content: [
        { type: "tool_use", id: toolUseId, name: "session_write_file", input: { path: "a.ts" } },
      ],
    },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function snapshotOf(blocks: SessionContextSnapshotBlock[]): SessionContextSnapshot {
  return {
    agentSessionId: "agent-turn-address",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-08-05T12:00:00.000Z",
  };
}

function textSnapshot(turnCount: number): SessionContextSnapshot {
  const blocks: SessionContextSnapshotBlock[] = [];
  for (let i = 0; i < turnCount; i++) blocks.push(textBlock(i, i % 2 === 0 ? "user" : "assistant"));
  return snapshotOf(blocks);
}

function turnAnchor(turnIndex: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${TURN_ANCHOR_ATTR}="${turnIndex}"]`);
}

/** Whether an element carries the addressed-mark ring. */
function isMarked(el: Element | null): boolean {
  return el?.className.includes("ring-2") === true;
}

afterEach(cleanup);

describe("ConversationView — turn anchors (mt#3791)", () => {
  test("every rendered turn carries its transcript position as an anchor", () => {
    renderCV(textSnapshot(4));
    for (let i = 0; i < 4; i++) {
      expect(turnAnchor(i)).not.toBeNull();
    }
  });

  test("the anchor is the block's own turnIndex, not its position in the array", () => {
    // A transcript whose renderable turns are non-contiguous — the real shape,
    // since non-turn lines produce no block. Anchoring on array position would
    // label these 0/1/2 and every address would land one or more turns off.
    renderCV(snapshotOf([textBlock(7, "user"), textBlock(11, "assistant")]));
    expect(turnAnchor(7)).not.toBeNull();
    expect(turnAnchor(11)).not.toBeNull();
    expect(turnAnchor(0)).toBeNull();
    expect(turnAnchor(1)).toBeNull();
  });

  test("a tool call carries its tool_use id as an anchor", () => {
    renderCV(snapshotOf([toolCallBlock(0, "toolu_01ABC")]));
    expect(
      document.querySelector(`[${TOOL_USE_ANCHOR_ATTR}="toolu_01ABC"]`)
    ).not.toBeNull();
  });
});

describe("ConversationView — landing on an addressed turn (mt#3791)", () => {
  test("the addressed turn is marked and no other turn is", () => {
    renderCV(textSnapshot(4), { turnIndex: 2 });
    expect(isMarked(turnAnchor(2))).toBe(true);
    expect(isMarked(turnAnchor(1))).toBe(false);
    expect(isMarked(turnAnchor(3))).toBe(false);
  });

  test("with no address, nothing is marked and no note renders", () => {
    // The regression guard: every conversation link that carries no address —
    // which is all of them outside the film — must behave exactly as before.
    renderCV(textSnapshot(4));
    expect(screen.queryByTestId("turn-address-unresolved")).toBeNull();
    for (let i = 0; i < 4; i++) expect(isMarked(turnAnchor(i))).toBe(false);
  });

  test("an address older than the tail window is REVEALED, not left unmounted", async () => {
    // The defect this task exists to fix, in its worst form: with 200 turns the
    // window mounts only the newest INITIAL_TURNS, so turn 5 is not in the DOM
    // at all and no amount of scrolling reaches it.
    const total = INITIAL_TURNS * 4;
    renderCV(textSnapshot(total), { turnIndex: 5 });
    await waitFor(() => {
      expect(turnAnchor(5)).not.toBeNull();
    });
    expect(isMarked(turnAnchor(5))).toBe(true);
    expect(screen.getByText("turn-5 body")).toBeDefined();
  });

  test("a turn well inside the tail window needs no reveal", () => {
    const total = INITIAL_TURNS * 2;
    renderCV(textSnapshot(total), { turnIndex: total - 3 });
    expect(isMarked(turnAnchor(total - 3))).toBe(true);
  });
});

describe("ConversationView — tool-grain address (mt#3791)", () => {
  const parallelBatch = () =>
    snapshotOf([
      textBlock(0, "user"),
      {
        id: "block-1",
        type: "assistant-text",
        source: "observed",
        content: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_FIRST", name: "session_read_file", input: { path: "a" } },
            { type: "tool_use", id: "toolu_SECOND", name: "session_read_file", input: { path: "b" } },
          ],
        },
        timestamp: ts(1),
        turnIndex: 1,
        rawJsonlType: "assistant",
      },
    ]);

  test("marks the named call, not the whole turn and not its sibling", () => {
    renderCV(parallelBatch(), { turnIndex: 1, toolUseId: "toolu_SECOND" });
    expect(isMarked(document.querySelector(`[${TOOL_USE_ANCHOR_ATTR}="toolu_SECOND"]`))).toBe(true);
    expect(isMarked(document.querySelector(`[${TOOL_USE_ANCHOR_ATTR}="toolu_FIRST"]`))).toBe(false);
    // The ring belongs on the call the reader asked for; ringing the turn as
    // well would say "this whole turn" when they picked one action out of two.
    expect(isMarked(turnAnchor(1))).toBe(false);
  });

  test("the addressed call arrives expanded", () => {
    // The reader clicked through from a ribbon row already showing this call's
    // params and result; landing on a collapsed row would hide it.
    renderCV(parallelBatch(), { turnIndex: 1, toolUseId: "toolu_SECOND" });
    const buttons = document.querySelectorAll('[aria-expanded="true"]');
    expect(buttons.length).toBe(1);
  });

  test("a turn-grain address marks the turn itself", () => {
    renderCV(parallelBatch(), { turnIndex: 1 });
    expect(isMarked(turnAnchor(1))).toBe(true);
    expect(isMarked(document.querySelector(`[${TOOL_USE_ANCHOR_ATTR}="toolu_FIRST"]`))).toBe(false);
  });
});

// PR #2693 R1: `turnTarget` sits on the props EVERY variant carries, and the
// driven-session branch silently dropped it — the address worked from a fetched
// conversation and from a pre-fetched snapshot, and did nothing in the third
// mode, which is the divergence that is hardest to diagnose from the outside.
describe("ConversationView — an address reaches every variant (mt#3791)", () => {
  const drivenBlock = (index: number): SessionContextSnapshotBlock => ({
    ...textBlock(index, "assistant"),
    id: `driven:turn:${index}`,
  });

  test("the driven-session variant honors an address", () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MemoryRouter>
          <ConversationView
            drivenSessionId="driven-addressed"
            drivenBlocks={[drivenBlock(0), drivenBlock(1), drivenBlock(2)]}
            turnTarget={{ turnIndex: 1 }}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(isMarked(turnAnchor(1))).toBe(true);
    expect(isMarked(turnAnchor(0))).toBe(false);
  });

  test("the pre-fetched-snapshot variant honors an address", () => {
    renderCV(textSnapshot(3), { turnIndex: 1 });
    expect(isMarked(turnAnchor(1))).toBe(true);
  });
});

describe("ConversationView — an address that resolves to nothing (mt#3791)", () => {
  test("says so rather than silently landing on the newest exchange", () => {
    renderCV(textSnapshot(4), { turnIndex: 99 });
    expect(screen.getByTestId("turn-address-unresolved")).toBeDefined();
    // The thread still renders in full — the address failing is not a reason to
    // withhold the conversation.
    expect(screen.getByText("turn-0 body")).toBeDefined();
  });

  test("a turn the thread renders nothing for is unresolved, not a blank landing", () => {
    // An abandoned rewind branch is filtered before render, so its turnIndex
    // exists in the transcript and names no element.
    const abandoned: SessionContextSnapshotBlock = {
      ...textBlock(1, "user"),
      isAbandonedBranch: true,
    };
    renderCV(snapshotOf([textBlock(0, "user"), abandoned, textBlock(2, "assistant")]), {
      turnIndex: 1,
    });
    expect(screen.getByTestId("turn-address-unresolved")).toBeDefined();
  });

  test("an unresolvable CALL inside a resolvable turn still lands on the turn", () => {
    renderCV(snapshotOf([toolCallBlock(0, "toolu_REAL")]), {
      turnIndex: 0,
      toolUseId: "toolu_GONE",
    });
    // Not the unresolved note: the turn is a real place to land, and the reader
    // is closer to what they asked for there than at the tail.
    expect(screen.queryByTestId("turn-address-unresolved")).toBeNull();
  });
});
