/**
 * Pinned dispatch-brief tests (mt#4909).
 *
 * mt#4354 gave a generated dispatch prompt its own author class and render. This
 * task makes it REACHABLE: the brief is turn 0, and the conversation is FETCHED
 * a page at a time from the tail (mt#4263), so on anything longer than one page
 * turn 0 was never fetched at all — three `load earlier turns` round trips away
 * on the conversation the defect was measured against.
 *
 * The server answers by sending turn 0 as its own `headBlock` when the slice did
 * not reach it; these tests cover what the client does with that field. Note
 * they are about the FETCH boundary, not the render window — the two are
 * different mechanisms with different controls, and conflating them is what the
 * original spec got wrong.
 *
 * What is NOT here: whether the pin is visually distinguishable, and the
 * scroll-driven reveal. Both are geometry, and this suite runs under happy-dom,
 * which has no layout engine (see `ConversationView.windowing.test.tsx`).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConversationView } from "./ConversationView";
import { DISPATCH_BRIEF_ORIGIN } from "../lib/turn-origin";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderCV(snapshot: SessionContextSnapshot) {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ConversationView snapshot={snapshot} />
    </QueryClientProvider>
  );
}

const BRIEF_PROSE = "Implement mt#4909 in the session workspace. Report when the PR is open.";

/**
 * A turn 0 shaped the way the server stamps one.
 *
 * `userOrigin` is the whole trigger — `asDispatchBrief` in
 * `../lib/conversation-turn-assembly.ts` branches on exactly this value, so a
 * block carrying it is what a real dispatch brief looks like to every client
 * path. The prose content is incidental.
 */
function briefBlock(): SessionContextSnapshotBlock {
  return {
    id: "block-0",
    type: "user-prompt",
    source: "observed",
    content: { role: "user", content: BRIEF_PROSE },
    timestamp: new Date(Date.UTC(2026, 5, 10, 12, 0, 0)).toISOString(),
    turnIndex: 0,
    userOrigin: DISPATCH_BRIEF_ORIGIN,
    rawJsonlType: "user",
  };
}

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

/**
 * A windowed page that did NOT reach turn 0 — the state this task exists for.
 *
 * `nextBefore` non-null is what makes it a mid-conversation page: the reader is
 * looking at the tail and the server still holds history in front of it.
 */
function windowedTail(opts: { withHeadBlock: boolean }): SessionContextSnapshot {
  const blocks: SessionContextSnapshotBlock[] = [];
  for (let i = 145; i < 195; i++) {
    blocks.push(turnBlock(i, i % 2 === 0 ? "user" : "assistant"));
  }
  return {
    agentSessionId: "agent-test-pinned-brief",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-06-10T12:00:00.000Z",
    ...(opts.withHeadBlock ? { headBlock: briefBlock() } : {}),
    window: {
      totalTurns: 195,
      returnedTurns: 50,
      oldestTurnIndex: 145,
      nextBefore: 145,
      hasMore: true,
    },
  };
}

describe("ConversationView — pinned dispatch brief (mt#4909)", () => {
  afterEach(cleanup);

  test("a head block renders the brief at first paint, with no interaction", () => {
    renderCV(windowedTail({ withHeadBlock: true }));

    // The defect: reaching this took three `load earlier turns` clicks. Nothing
    // is clicked here, so a hit means it is reachable on arrival.
    expect(screen.getByTestId("pinned-dispatch-brief")).toBeTruthy();
    expect(screen.getByTestId("dispatch-brief")).toBeTruthy();
    expect(screen.getByTestId("pinned-dispatch-brief").textContent).toContain("mt#4909");
  });

  test("no head block renders no pinned affordance at all", () => {
    renderCV(windowedTail({ withHeadBlock: false }));

    // A root conversation, or a subagent dispatched before the mt#2292 stamp.
    // The requirement is ABSENT, not empty: an empty container would still take
    // vertical space above every such conversation.
    expect(screen.queryByTestId("pinned-dispatch-brief")).toBeNull();
    expect(screen.queryByTestId("dispatch-brief")).toBeNull();
  });

  test("the pin does not widen the fetch: only the tail page's turns render", () => {
    renderCV(windowedTail({ withHeadBlock: true }));

    // The brief rides along as ONE extra block. Had the pin been implemented by
    // seeding the window from turn 0 instead, this conversation would render all
    // 195 — the regression the tail-first budget exists to prevent. The page
    // covers 145..194, so a turn from before it appearing means the budget went.
    expect(screen.getByText("turn-145 body")).toBeTruthy();
    expect(screen.queryByText("turn-0 body")).toBeNull();
    expect(screen.queryByText("turn-100 body")).toBeNull();
    expect(screen.queryByText("turn-144 body")).toBeNull();
  });

  test("the brief sits ABOVE the conversation's own turns", () => {
    renderCV(windowedTail({ withHeadBlock: true }));

    const pinned = screen.getByTestId("pinned-dispatch-brief");
    const firstWindowedTurn = screen.getByText("turn-145 body");
    // `DOCUMENT_POSITION_FOLLOWING` on the pinned node means the turn comes
    // after it in document order. Reading top-down: the assignment, then the
    // boundary, then the turns — the order they actually occurred in.
    //
    // Anchored on a rendered TURN rather than on the start boundary, because
    // the boundary's fetch branch (`thread-unfetched-above`) needs an
    // `onLoadOlder` callback that only the self-fetching path supplies — it can
    // never render through the `{ snapshot }` prop this suite drives.
    expect(
      pinned.compareDocumentPosition(firstWindowedTurn) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test("once turn 0 is fetched the brief renders exactly once, not twice", () => {
    // The post-paging state the server produces: a slice that reached index 0
    // carries the brief in `blocks` and sends NO head block, because
    // `mergeSnapshotPages` takes that field from the oldest page. This asserts
    // the two halves cannot both render — the duplication this design avoids
    // without any client-side de-duplication.
    const reachedStart: SessionContextSnapshot = {
      agentSessionId: "agent-test-pinned-brief",
      harness: "claude_code",
      blocks: [briefBlock(), turnBlock(1, "assistant")],
      assembledAt: "2026-06-10T12:00:00.000Z",
      window: {
        totalTurns: 195,
        returnedTurns: 2,
        oldestTurnIndex: 0,
        nextBefore: null,
        hasMore: false,
      },
    };

    renderCV(reachedStart);

    expect(screen.queryByTestId("pinned-dispatch-brief")).toBeNull();
    expect(screen.getAllByTestId("dispatch-brief")).toHaveLength(1);
  });
});
