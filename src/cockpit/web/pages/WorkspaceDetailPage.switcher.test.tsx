/**
 * Conversation-switcher legibility and placement (mt#3691).
 *
 * Two claims are checked here, both at the level happy-dom can actually settle:
 *
 *   1. LEGIBILITY — a switcher item's primary text is the server-computed
 *      label, with the link class beside it, and never a bare uuid.
 *   2. PLACEMENT — the switcher is INSIDE `run-detail-chrome`, the sticky
 *      container, rather than in the Conversation tab's scrolling body where it
 *      used to live.
 *
 * Placement is a containment assertion, not a geometry one: this suite runs
 * under happy-dom, which has no layout engine — `getBoundingClientRect()` reads
 * 0 for everything (`src/cockpit/CLAUDE.md` §Asserting layout geometry). What
 * containment DOES settle is the thing that was actually wrong: the picker was
 * a descendant of the tab body, so it scrolled away with the transcript. That it
 * is now a descendant of the sticky container is the structural half; the
 * "still on screen after scrolling 4000 turns" half is AT2, and it is live.
 *
 * Items are exercised one at a time via candidate ORDER rather than by opening
 * the dropdown — the same constraint `WorkspaceDetailPage.chrome.test.tsx`
 * documents for its own AT3. The switcher is a Radix `Select` whose list is
 * portalled and opened by pointer events happy-dom does not deliver, so the
 * rendered surface reachable here is the TRIGGER, which mirrors the active
 * item's content through `SelectValue`. Making each candidate active in turn
 * therefore renders each item's content for real, one render at a time, instead
 * of asserting a mock.
 *
 * Run via:
 *   bun run test:components
 *   (or) bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts
 *        --timeout=15000 src/cockpit/web/pages/WorkspaceDetailPage.switcher.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WorkspaceDetailPage } from "./WorkspaceDetailPage";
import { TabsProvider } from "../lib/tabs";

const WORKSPACE_ID = "mt3691-switcher-test";

/** Full uuids — the thing that must NOT be the primary text of an item. */
const CONV_ORCHESTRATOR = "11111111-2222-3333-4444-555555555555";
const CONV_SUBAGENT = "66666666-7777-8888-9999-aaaaaaaaaaaa";

interface CandidateFixture {
  agentSessionId: string;
  startedAt: string | null;
  source: "link-row" | "derived-agent-id";
  label?: string;
  linkType?: string | null;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function mockFetches(conversations: CandidateFixture[]) {
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";

    if (pathname === `/api/agents/${encodeURIComponent(WORKSPACE_ID)}`) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            session: {
              sessionId: WORKSPACE_ID,
              shortId: "ws#3691",
              taskId: "mt#3691",
              taskTitle: "Conversation switcher legibility",
              status: "IN-PROGRESS",
              liveness: "healthy",
              agentId: null,
              branch: "task/mt-3691",
              repoName: "edobry/minsky",
              repoUrl: null,
              createdAt: null,
              lastActivityAt: null,
              lastCommitHash: null,
              lastCommitMessage: null,
              commitCount: 0,
            },
            commits: [],
            pr: null,
            conversation: conversations[0]
              ? { agentSessionId: conversations[0].agentSessionId }
              : null,
            conversations,
            driven: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    // Presence is chrome-adjacent and not under test here; 404 degrades it to
    // "no chip", which keeps the switcher assertions isolated from it.
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
}

function renderWorkspaceDetailPage() {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={[`/agents/${WORKSPACE_ID}`]}>
      <QueryClientProvider client={queryClient}>
        <TabsProvider>
          <Routes>
            <Route path="/agents/:id" element={<WorkspaceDetailPage />} />
          </Routes>
        </TabsProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const orchestrator = (): CandidateFixture => ({
  agentSessionId: CONV_ORCHESTRATOR,
  startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  source: "link-row",
  label: "Conversation switcher legibility",
  linkType: "session_creator",
});

const subagent = (): CandidateFixture => ({
  agentSessionId: CONV_SUBAGENT,
  startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  source: "link-row",
  label: "implementer — mt#3691",
  linkType: "subagent_spawn",
});

describe("mt#3691 — the switcher names conversations instead of listing uuids", () => {
  // AT1. Each row of this table is one candidate made ACTIVE, which is what
  // renders its content into the trigger. Together they cover the mixed
  // orchestrator+subagent workspace AT1 describes — 14 of which exist in prod.
  test.each([
    ["the orchestrator conversation", orchestrator(), subagent(), "Session creator"],
    ["the subagent transcript", subagent(), orchestrator(), "Subagent spawn"],
  ])(
    "AT1: with %s active, the switcher shows its label and its link class",
    async (_name, active, other, expectedChip) => {
      mockFetches([active, other]);
      const { getByTestId } = renderWorkspaceDetailPage();

      const switcher = await waitFor(() => getByTestId("conversation-switcher"));
      const text = switcher.textContent ?? "";

      expect(text).toContain(active.label as string);
      expect(text).toContain(expectedChip);
      // The ACTIVE candidate's content, not every candidate's: Radix portals
      // the option list, so what renders here is the trigger alone. Without
      // this the two table rows would both pass on a build that dumped every
      // item inline, and neither would show that the switcher distinguishes
      // them.
      expect(text).not.toContain(other.label as string);
      // The uuid is reachable (the item carries it as a `title`), but it is not
      // what the operator reads — that is the whole defect this closes.
      expect(text).not.toContain(active.agentSessionId);
      expect(text).not.toContain(other.agentSessionId);
    }
  );

  test("AT1: the two candidates carry DIFFERENT link classes", () => {
    // Guards the fixture itself: if both sides of the table above named the
    // same class, each assertion would still pass while proving nothing about
    // an operator being able to tell them apart.
    expect(orchestrator().linkType).not.toBe(subagent().linkType);
  });

  test("the start time renders as a relative age", async () => {
    mockFetches([orchestrator(), subagent()]);
    const { getByTestId } = renderWorkspaceDetailPage();

    const switcher = await waitFor(() => getByTestId("conversation-switcher"));
    expect(switcher.textContent).toContain("2h ago");
  });
});

describe("mt#3691 — the switcher is pinned, not in the scrolling tab body", () => {
  test("the switcher is a descendant of the sticky chrome container", async () => {
    mockFetches([orchestrator(), subagent()]);
    const { getByTestId } = renderWorkspaceDetailPage();

    const chrome = await waitFor(() => getByTestId("run-detail-chrome"));
    const switcher = getByTestId("conversation-switcher");

    // Containment IS the fix (mirrors mt#3400's driven-banner assertion): the
    // picker used to be a descendant of the tab body, so on the Conversation
    // tab it left the viewport the moment the transcript reached its live edge.
    expect(chrome.contains(switcher)).toBe(true);
    expect(chrome.className).toContain("sticky");
    expect(chrome.className).toContain("top-0");
  });

  test("it renders on the Overview tab too, not only where the transcript is", async () => {
    // The selection keys the presence chip, the Context tab, and the Film tab —
    // so it is chrome, not Conversation-tab furniture. This is the default tab.
    mockFetches([orchestrator(), subagent()]);
    const { getByTestId } = renderWorkspaceDetailPage();

    await waitFor(() => getByTestId("conversation-switcher"));
  });
});

describe("mt#3691 — the switcher's trigger condition is unchanged", () => {
  test("AT3: a single-conversation workspace renders no switcher", async () => {
    // 496 of 584 linked workspaces (verified 2026-08-04). A switcher over one
    // option is chrome that answers a question nobody asked.
    mockFetches([orchestrator()]);
    const { getByTestId, queryByTestId } = renderWorkspaceDetailPage();

    await waitFor(() => getByTestId("run-detail-chrome"));
    expect(queryByTestId("conversation-switcher")).toBeNull();
  });

  test("a workspace with no conversation renders no switcher", async () => {
    mockFetches([]);
    const { getByTestId, queryByTestId } = renderWorkspaceDetailPage();

    await waitFor(() => getByTestId("run-detail-chrome"));
    expect(queryByTestId("conversation-switcher")).toBeNull();
  });
});

describe("mt#3691 — degraded candidates stay legible", () => {
  test("a candidate with no server label falls back to a shortened id", async () => {
    // The server omits `label` when the enrichment lookup degraded. The
    // fallback must not be the full uuid — that is the state this task removed.
    const unlabeled: CandidateFixture = {
      agentSessionId: CONV_ORCHESTRATOR,
      startedAt: null,
      source: "link-row",
      linkType: "cwd_match",
    };
    mockFetches([unlabeled, subagent()]);
    const { getByTestId } = renderWorkspaceDetailPage();

    const switcher = await waitFor(() => getByTestId("conversation-switcher"));
    const text = switcher.textContent ?? "";

    expect(text).toContain("11111111…");
    expect(text).not.toContain(CONV_ORCHESTRATOR);
    expect(text).toContain("CWD match");
  });

  test("a candidate with no link type renders no chip rather than an empty one", async () => {
    const noLinkType: CandidateFixture = {
      agentSessionId: CONV_ORCHESTRATOR,
      startedAt: null,
      source: "derived-agent-id",
      label: "A conversation with no link row",
      linkType: null,
    };
    mockFetches([noLinkType, subagent()]);
    const { getByTestId } = renderWorkspaceDetailPage();

    const switcher = await waitFor(() => getByTestId("conversation-switcher"));
    const text = switcher.textContent ?? "";

    expect(text).toContain("A conversation with no link row");
    // No stray separator, placeholder, or the string "null" where a chip would be.
    expect(text).not.toContain("null");
  });
});
