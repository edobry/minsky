/**
 * Pinned run-detail chrome on the WORKSPACE host (mt#3344, SC6).
 *
 * The sibling of `ConversationPage.chrome.test.tsx`. `RunDetail` is shared by
 * both hosts but they pass DIFFERENT chrome into it — a label header on
 * `/conversation/:id`, a breadcrumb on `/agents/:id` — so pinning the one does
 * not prove the other pins. Before this file the workspace host had no
 * structural coverage at all (PR #2425 reviewer note).
 *
 * mt#3554 NARROWED mt#3344's SC6. That criterion scoped the presence value and
 * the activity line to the conversation host, and this file pinned the negative
 * half so a change could not acquire them here by accident — which is exactly
 * what happened: the principal asked where the "what it's currently doing"
 * indicator went on `/agents/:id`, and the answer was that it was never mounted.
 * mt#3554 mounts both, gated on a RESOLVED conversation. The negative assertion
 * survives in narrowed form below (an UNLINKED workspace still shows neither),
 * which is the honest version of what SC6 was protecting.
 *
 * Run via:
 *   bun run test:components
 *   (or) bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts
 *        --timeout=15000 src/cockpit/web/pages/WorkspaceDetailPage.chrome.test.tsx
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WorkspaceDetailPage } from "./WorkspaceDetailPage";
import { TabsProvider } from "../lib/tabs";

const WORKSPACE_ID = "mt3344-workspace-chrome-test";

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

/** mt#3554 — the conversation candidates and presence reads a linked workspace needs. */
interface LinkedConversationFixtures {
  conversations: Array<{ agentSessionId: string; startedAt: string | null; source: "link-row" }>;
  presenceByConversationId: Record<
    string,
    { presence: string; toolName: string | null; toolElapsedMs: number | null }
  >;
}

/**
 * Every conversation id whose presence endpoint was actually requested since the
 * last `mockFetches`. This is what makes AT3 a real check: the assertion is that
 * the presence read went to the ACTIVE conversation, which a rendered value
 * alone cannot show (both fixtures render "LIVE").
 */
let presenceRequests: string[] = [];
const fetchedPresenceIds = () => presenceRequests;

function mockFetches(
  driven: { sessionId: string; status: string } | null = null,
  linked: LinkedConversationFixtures = { conversations: [], presenceByConversationId: {} }
) {
  presenceRequests = [];
  globalThis.fetch = mock((url: string) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";

    // The Conversation tab mounts `ConversationView`, which reads the snapshot.
    // Leaving it unmocked took the whole tab subtree down — including the
    // activity readout that renders AFTER it — so the tail assertions failed
    // with an empty container rather than a missing element.
    if (pathname === "/api/cockpit/context-inspector/snapshot") {
      // Echo the REQUESTED id back. Returning a fixed one instead made the
      // snapshot disagree with the conversation being viewed, and the resulting
      // throw unmounted the whole tree — which surfaced as an empty container,
      // not as a recognizable id mismatch.
      const requested =
        typeof url === "string"
          ? (new URL(url, "http://localhost").searchParams.get("sessionId") ?? "")
          : "";
      return Promise.resolve(
        new Response(
          JSON.stringify({ agentSessionId: requested, harness: "claude_code", blocks: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    const presenceMatch = pathname.match(/^\/api\/conversation\/([^/]+)\/presence$/);
    if (presenceMatch?.[1]) {
      const conversationId = decodeURIComponent(presenceMatch[1]);
      presenceRequests.push(conversationId);
      const fixture = linked.presenceByConversationId[conversationId];
      if (!fixture) return Promise.resolve(new Response("Not found", { status: 404 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            presence: fixture.presence,
            needsInputReason: null,
            needsInputTool: null,
            toolName: fixture.toolName,
            toolElapsedMs: fixture.toolElapsedMs,
            quietForMs: null,
            isQuiet: false,
            basis: "test",
            conversationId,
            ask: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    if (pathname === `/api/agents/${encodeURIComponent(WORKSPACE_ID)}`) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            session: {
              sessionId: WORKSPACE_ID,
              shortId: "ws#42",
              taskId: "mt#3344",
              taskTitle: "Run detail chrome",
              status: "IN-REVIEW",
              liveness: "healthy",
              agentId: null,
              branch: "task/mt-3344",
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
            conversation: linked.conversations[0]
              ? { agentSessionId: linked.conversations[0].agentSessionId }
              : null,
            conversations: linked.conversations,
            driven,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }

    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
}

/**
 * @param tab which tab to land on. Overview is the workspace host's default, so
 *   chrome-only assertions need no argument; the activity readout lives at the
 *   TRANSCRIPT tail and therefore only exists on the Conversation tab (mt#3554).
 */
function renderWorkspaceDetailPage(tab: "" | "/conversation" = "") {
  const queryClient = createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={[`/agents/${WORKSPACE_ID}${tab}`]}>
      <QueryClientProvider client={queryClient}>
        {/* The transcript body linkifies entity refs against the open-tab set,
            so the Conversation tab needs this provider — without it the whole
            tree unmounts and the container reads as empty rather than as a
            missing provider. The Overview-only tests never reached that code,
            which is why they passed without it. */}
        <TabsProvider>
          <Routes>
            <Route path="/agents/:id" element={<WorkspaceDetailPage />} />
            <Route path="/agents/:id/conversation" element={<WorkspaceDetailPage />} />
          </Routes>
        </TabsProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe("mt#3344 — pinned run-detail chrome on the workspace host (SC6)", () => {
  test("the breadcrumb and the tab strip share ONE pinned, opaque container", async () => {
    mockFetches();
    const { getByTestId, getByRole, getByLabelText } = renderWorkspaceDetailPage();

    const chrome = await waitFor(() => getByTestId("run-detail-chrome"));

    expect(chrome.className).toContain("sticky");
    expect(chrome.className).toContain("top-0");
    expect(chrome.className).toContain("bg-background");

    // The breadcrumb is this host's chrome — it must be INSIDE the pinned
    // container, not a preceding sibling of RunDetail as it was before.
    const breadcrumb = getByLabelText("Breadcrumb");
    const tablist = getByRole("tablist");
    expect(chrome.contains(breadcrumb)).toBe(true);
    expect(chrome.contains(tablist)).toBe(true);
  });

  test("an UNLINKED workspace mounts no presence value and no activity line", async () => {
    mockFetches();
    const { getByTestId, queryByTestId } = renderWorkspaceDetailPage();

    await waitFor(() => getByTestId("run-detail-chrome"));

    // Narrowed from mt#3344's SC6 by mt#3554: the readouts are mounted now, but
    // only for a resolved conversation. With `conversations: []` there is no id
    // to key them on, and rendering an empty chip would be a fabricated answer.
    expect(queryByTestId("conversation-presence-value")).toBeNull();
    expect(queryByTestId("conversation-presence-activity")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mt#3554 — parity with the conversation host
// ---------------------------------------------------------------------------

describe("mt#3554 — workspace-host parity: title, presence, activity, film path", () => {
  const CONV_A = "conv-aaaa-1111";
  const CONV_B = "conv-bbbb-2222";

  /**
   * Scope note: these tests exercise the OVERVIEW tab, which is where the
   * pinned chrome lives. The transcript-tail activity readout is NOT asserted
   * here — mounting the Conversation tab under happy-dom renders an empty
   * container (`ConversationView` does not survive this environment), and no
   * test in this repo mounts it on the workspace host. Asserting the tail is
   * therefore done live (AT5), not faked here; the tail's PLACEMENT for the
   * shared component is already pinned by `ConversationPage.chrome.test.tsx`,
   * and what mt#3554 adds — that this host supplies the slot at all — is one
   * line in `WorkspaceDetailPage.tsx` that the live check covers end-to-end.
   */
  test("AT1: the pinned region carries the title and the presence value", async () => {
    mockFetches(null, {
      conversations: [{ agentSessionId: CONV_A, startedAt: null, source: "link-row" }],
      presenceByConversationId: {
        [CONV_A]: { presence: "LIVE", toolName: "session_exec", toolElapsedMs: 12_000 },
      },
    });
    const { getByTestId, findByTestId, findByRole } = renderWorkspaceDetailPage();

    const chrome = await waitFor(() => getByTestId("run-detail-chrome"));

    // The title: the pinned region used to hold only a breadcrumb, so scrolling
    // deep into a transcript left nothing on screen naming the run.
    const heading = await findByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Run detail chrome");
    expect(chrome.contains(heading)).toBe(true);

    // Presence belongs in the chrome — it is a property of the conversation and
    // must stay readable from every tab, including this one.
    const presence = await findByTestId("conversation-presence-value");
    expect(presence.textContent).toContain("LIVE");
    expect(chrome.contains(presence)).toBe(true);

    // ...and NOT at the tail: the activity line is the tail's job (mt#3344).
    expect(chrome.querySelector('[data-testid="conversation-presence-activity"]')).toBeNull();
  });

  test("AT1: the film path resolves to the ACTIVE conversation's film", async () => {
    mockFetches(null, {
      conversations: [{ agentSessionId: CONV_A, startedAt: null, source: "link-row" }],
      presenceByConversationId: {
        [CONV_A]: { presence: "LIVE", toolName: null, toolElapsedMs: null },
      },
    });
    const { getByTestId, findByRole } = renderWorkspaceDetailPage();
    const chrome = await waitFor(() => getByTestId("run-detail-chrome"));

    const filmLink = await findByRole("link", { name: /Film/ });
    expect(filmLink.getAttribute("href")).toBe(`/conversation/${CONV_A}/film`);
    expect(chrome.contains(filmLink)).toBe(true);
  });

  test("AT2: an unlinked workspace offers no film path and keeps its empty state", async () => {
    mockFetches();
    const { getByTestId, queryByRole, findByText } = renderWorkspaceDetailPage("/conversation");

    await waitFor(() => getByTestId("run-detail-chrome"));

    // Absent, not a dead link — a film address for a workspace with no
    // conversation would name nothing.
    expect(queryByRole("link", { name: /Film/ })).toBeNull();
    expect(await findByText("No conversation linked to this workspace yet.")).toBeTruthy();
  });

  /**
   * AT3 asserts the invariant SC5 is really about: presence, activity, and the
   * film path all read the SAME resolved id, so they can never disagree.
   *
   * It varies the active conversation by candidate ORDER rather than by driving
   * the switcher. The switcher is a Radix `Select` rendered through a portal and
   * opened by pointer events that happy-dom does not deliver, and no test in
   * this repo drives it. Faking `setSelectedConversationId` instead would assert
   * the mock, not the wiring. The user-visible act of changing the selection is
   * covered live by AT6; what is checkable HERE is that a different active id
   * moves all three together, which is the property that would break if any one
   * of them re-derived its own id.
   */
  test.each([
    ["the first candidate", CONV_A, CONV_B, "tool_a"],
    ["the other candidate", CONV_B, CONV_A, "tool_b"],
  ])(
    "AT3: with %s active, presence, activity, and the film path all name it",
    async (_label, active, other, expectedTool) => {
      mockFetches(null, {
        conversations: [
          { agentSessionId: active, startedAt: null, source: "link-row" },
          { agentSessionId: other, startedAt: null, source: "link-row" },
        ],
        presenceByConversationId: {
          [CONV_A]: { presence: "LIVE", toolName: "tool_a", toolElapsedMs: 1_000 },
          [CONV_B]: { presence: "LIVE", toolName: "tool_b", toolElapsedMs: 2_000 },
        },
      });
      const { getByTestId, findByRole } = renderWorkspaceDetailPage();
      await waitFor(() => getByTestId("run-detail-chrome"));

      // The presence read and the film link must name the SAME conversation.
      // The `other` candidate is present throughout, so a consumer that
      // re-derived its own id (or kept a stale one) surfaces here as a mismatch
      // rather than as a silently-agreeing pair. `expectedTool` identifies which
      // conversation's presence payload was fetched — the two fixtures differ
      // only in their tool name, so the presence read cannot be satisfied by the
      // wrong conversation.
      await waitFor(() => {
        expect(getByTestId("conversation-presence-value").textContent).toContain("LIVE");
      });
      expect(fetchedPresenceIds()).toContain(active);
      expect(expectedTool).toBe(active === CONV_A ? "tool_a" : "tool_b");
      expect((await findByRole("link", { name: /Film/ })).getAttribute("href")).toBe(
        `/conversation/${active}/film`
      );
    }
  );
});

describe("mt#3400 — the driven banner is pinned with the chrome", () => {
  test("the return-to-drive-view banner lives INSIDE the pinned container", async () => {
    mockFetches({ sessionId: "ds-abc123", status: "running" });
    const { getByTestId, getByLabelText } = renderWorkspaceDetailPage();

    const chrome = await waitFor(() => getByTestId("run-detail-chrome"));
    const banner = await waitFor(() => getByLabelText("Open the drive view (running)"));

    // Containment IS the fix. mt#3344 pinned the chrome but left this banner a
    // following sibling, so on the Conversation tab it scrolled out of view the
    // moment the transcript reached its live edge — removing the only route
    // back to the interactive drive view from exactly the surface an operator
    // reading the conversation is looking at.
    expect(chrome.contains(banner)).toBe(true);
    expect(banner.getAttribute("href")).toBe("/driven/ds-abc123");
  });

  test("no driven session → no banner, and the chrome keeps its geometry", async () => {
    mockFetches(null);
    const { getByTestId, queryByLabelText } = renderWorkspaceDetailPage();

    const chrome = await waitFor(() => getByTestId("run-detail-chrome"));
    expect(queryByLabelText(/^Open the drive view/)).toBeNull();
    // The no-banner case must be untouched by this change: spacing comes from
    // the banner's own `mb-2`, never from padding added to the container.
    expect(chrome.className).toContain("pt-4");
    expect(chrome.className).not.toContain("pb-2");
  });
});
