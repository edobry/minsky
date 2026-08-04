/**
 * Spawn-boundary navigation rendering (mt#3692).
 *
 * The `→ subagent` badge used to be inert. It now links to the conversation the
 * Agent call spawned — per CALL, so a turn that dispatches several subagents
 * links each badge to its own child. The inverse affordance is the "Spawned by"
 * backlink on a conversation that IS a spawn.
 *
 * These assert the LINK TARGET, not merely that a link exists: the whole reason
 * this work was needed is that the previous join key resolved to the wrong
 * conversation rather than to none, which a bare "is there an anchor" assertion
 * would have passed.
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
  return new Date(Date.UTC(2026, 7, 4, 12, 0, index)).toISOString();
}

function agentCallBlock(
  index: number,
  calls: Array<{ toolUseId: string; agentKind?: string }>
): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: {
      role: "assistant",
      content: calls.map((c) => ({
        type: "tool_use",
        id: c.toolUseId,
        name: "Agent",
        input: { ...(c.agentKind ? { subagent_type: c.agentKind } : {}), prompt: "do the thing" },
      })),
    },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function snapshot(overrides: Partial<SessionContextSnapshot>): SessionContextSnapshot {
  return {
    agentSessionId: "parent-conversation",
    harness: "claude_code",
    blocks: [],
    assembledAt: ts(0),
    ...overrides,
  };
}

/** Every spawn badge currently rendered, linked or not. */
function spawnBadges(): HTMLElement[] {
  return screen.getAllByText(/→ subagent/);
}

afterEach(cleanup);

describe("spawn badge → child conversation", () => {
  test("a resolved spawn links to THAT call's child conversation", () => {
    renderCV(
      snapshot({
        blocks: [agentCallBlock(0, [{ toolUseId: "toolu_a", agentKind: "Explore" }])],
        spawnChildrenByToolUseId: { toolu_a: "child-conversation-a" },
      })
    );

    const links = screen.getAllByTestId("spawn-child-link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("/conversation/child-conversation-a");
    }
    expect(links[0]?.textContent).toContain("Explore");
  });

  test("an unresolved spawn renders a static badge with no link", () => {
    renderCV(
      snapshot({
        blocks: [agentCallBlock(0, [{ toolUseId: "toolu_a", agentKind: "Explore" }])],
        // The spawn exists but its child never resolved — still the majority
        // case today (~30% resolve), so this is the ordinary path, not an edge.
      })
    );

    expect(spawnBadges().length).toBeGreaterThan(0);
    expect(screen.queryByTestId("spawn-child-link")).toBeNull();
  });

  test("a stale spawn row keyed to a different call does NOT link this one", () => {
    renderCV(
      snapshot({
        blocks: [agentCallBlock(0, [{ toolUseId: "toolu_live", agentKind: "Explore" }])],
        // A pre-mt#3692 row that survived a re-derivation: it names a tool_use
        // id no longer present in this transcript. It must light up nothing.
        spawnChildrenByToolUseId: { toolu_orphaned: "child-conversation-x" },
      })
    );

    expect(spawnBadges().length).toBeGreaterThan(0);
    expect(screen.queryByTestId("spawn-child-link")).toBeNull();
  });

  test("a turn with several Agent calls links each badge to its own child", () => {
    renderCV(
      snapshot({
        blocks: [
          agentCallBlock(0, [
            { toolUseId: "toolu_a", agentKind: "Explore" },
            { toolUseId: "toolu_b", agentKind: "Plan" },
            { toolUseId: "toolu_c", agentKind: "reviewer" },
          ]),
        ],
        // Two resolve, one does not — the mixed case the former turn-granular
        // key could not represent at all.
        spawnChildrenByToolUseId: { toolu_a: "child-a", toolu_c: "child-c" },
      })
    );

    const hrefs = screen
      .getAllByTestId("spawn-child-link")
      .map((el) => el.getAttribute("href"))
      .filter((h): h is string => h !== null);

    // Each resolved call points at ITS OWN child, and the unresolved sibling
    // contributes no link.
    expect(new Set(hrefs)).toEqual(
      new Set(["/conversation/child-a", "/conversation/child-c"])
    );
    expect(hrefs).not.toContain("/conversation/child-b");
  });
});

describe("spawned-by backlink", () => {
  test("a conversation that IS a spawn links back to its parent", () => {
    renderCV(
      snapshot({
        agentSessionId: "child-conversation",
        blocks: [agentCallBlock(0, [{ toolUseId: "toolu_z" }])],
        spawnParent: { agentSessionId: "parent-conversation", agentKind: "Explore" },
      })
    );

    const backlink = screen.getByTestId("spawn-parent-backlink");
    expect(backlink.textContent).toContain("Spawned by");
    expect(backlink.textContent).toContain("Explore");
    expect(backlink.querySelector("a")?.getAttribute("href")).toBe(
      "/conversation/parent-conversation"
    );
  });

  test("the backlink still renders when the parent recorded no agent kind", () => {
    renderCV(
      snapshot({
        agentSessionId: "child-conversation",
        blocks: [agentCallBlock(0, [{ toolUseId: "toolu_z" }])],
        spawnParent: { agentSessionId: "parent-conversation" },
      })
    );

    const backlink = screen.getByTestId("spawn-parent-backlink");
    expect(backlink.querySelector("a")?.getAttribute("href")).toBe(
      "/conversation/parent-conversation"
    );
    expect(backlink.textContent).toContain("parent conversation");
  });

  test("a conversation with no spawn ancestry renders no backlink and no placeholder", () => {
    renderCV(
      snapshot({ blocks: [agentCallBlock(0, [{ toolUseId: "toolu_z" }])] })
    );

    expect(screen.queryByTestId("spawn-parent-backlink")).toBeNull();
    expect(screen.queryByText(/Spawned by/)).toBeNull();
  });
});
