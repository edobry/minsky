/**
 * "Watch this moment" link rendering (mt#3794).
 *
 * These assert the HREF, not merely that an anchor exists. The link's whole job
 * is to carry an address the film can resolve, so a bare "is there a link"
 * assertion would pass on a link pointing at the film's start — which is the
 * exact failure this feature exists to remove (the inverse direction shipped in
 * that state and was reported: mt#3791).
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   --path-ignore-patterns='services/**' \
 *   src/cockpit/web/widgets/ConversationView.film-link.test.tsx
 * (`bunfig.toml` ignores `src/cockpit/web/**` globally; the override is what
 * `package.json`'s `test:components` script passes.)
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ConversationView } from "./ConversationView";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

const FILM_PATH = "/conversation/conv-1/film";

function ts(index: number): string {
  return new Date(Date.UTC(2026, 7, 5, 12, 0, index)).toISOString();
}

/** An assistant turn with prose plus `calls` tool calls, at transcript position `index`. */
function assistantBlock(index: number, callIds: string[]): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: {
      role: "assistant",
      content: [
        { type: "text", text: "working on it" },
        ...callIds.map((id) => ({
          type: "tool_use",
          id,
          name: "Read",
          input: { file_path: `/tmp/${id}.ts` },
        })),
      ],
    },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function snapshot(blocks: SessionContextSnapshotBlock[]): SessionContextSnapshot {
  return {
    agentSessionId: "conv-1",
    harness: "claude_code",
    blocks,
    assembledAt: ts(0),
  };
}

function renderCV(blocks: SessionContextSnapshotBlock[], filmPath?: string) {
  return render(
    <MemoryRouter>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ConversationView snapshot={snapshot(blocks)} filmPath={filmPath} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function hrefs(): string[] {
  return screen
    .getAllByTestId("film-moment-link")
    .map((el) => el.getAttribute("href") ?? "")
    .filter(Boolean);
}

afterEach(cleanup);

describe("watch-this-moment link", () => {
  test("a tool call links to the film with BOTH halves of its address", () => {
    renderCV([assistantBlock(7, ["toolu_x"])], FILM_PATH);
    expect(hrefs()).toContain(`${FILM_PATH}?turn=7&toolUse=toolu_x`);
  });

  test("each call in a parallel batch carries its OWN tool id", () => {
    // The defect a turn-only address would have: every call in the batch would
    // link to the same moment, so clicking the second one would show the first.
    renderCV([assistantBlock(3, ["toolu_a", "toolu_b"])], FILM_PATH);
    const linked = hrefs();
    expect(linked).toContain(`${FILM_PATH}?turn=3&toolUse=toolu_a`);
    expect(linked).toContain(`${FILM_PATH}?turn=3&toolUse=toolu_b`);
  });

  test("the turn itself links at turn grain — no tool id", () => {
    renderCV([assistantBlock(7, ["toolu_x"])], FILM_PATH);
    expect(hrefs()).toContain(`${FILM_PATH}?turn=7`);
  });

  test("no film path, no affordance — the thread renders exactly as before", () => {
    // The workspace keyspace (`/agents/:id/conversation`) renders this same
    // thread with no film to link to (mt#3468).
    renderCV([assistantBlock(7, ["toolu_x"])]);
    expect(screen.queryAllByTestId("film-moment-link")).toHaveLength(0);
    // Control: the turn itself still rendered, so the assertion above is about
    // the affordance being absent and not about an empty thread.
    //
    // Asserted on the run header rather than the actor LABEL (mt#3845): these
    // fixture blocks record no model, and an assistant run with no resolvable
    // actor deliberately renders no label at all rather than a guessed one
    // (ask#7348's honest-degradation clause). The header row itself is
    // unconditional, so it is the control that actually means "something
    // rendered".
    expect(screen.getByTestId("run-header")).toBeDefined();
  });

  test("the link is reachable and labelled, not a hover-only mouse target", () => {
    // Hover-reveal governs VISIBILITY only. The anchor is always in the tab
    // order and always announces; `focus-visible` is what makes it usable
    // without a mouse, so it is asserted rather than left to the class soup.
    renderCV([assistantBlock(7, ["toolu_x"])], FILM_PATH);
    const link = screen.getAllByTestId("film-moment-link")[0]!;
    expect(link.getAttribute("aria-label")).toBe("Watch this moment in the film");
    expect(link.className).toContain("focus-visible:opacity-100");
  });
});
