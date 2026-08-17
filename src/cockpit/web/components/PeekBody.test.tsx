/**
 * PeekBody per-type body tests (mt#4069).
 *
 * The coverage ratchet in `PeekHost.test.tsx` asserts that every routable type
 * is DECLARED in `PEEKABLE_WITH_BODY`. That is a list assertion — it would still
 * pass if a declared type rendered nothing. This file asserts the other half:
 * each of the four types mt#4069 added actually renders its real body.
 *
 * Each test stubs the page's own endpoint and asserts on content that only the
 * shared body produces, so an adapter wired to the wrong component or the wrong
 * query key fails here rather than showing a blank pane in the drawer.
 *
 * Run via `bun run test:components`.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { PeekBody } from "./PeekBody";
import { ROUTABLE_ENTITY_TYPES } from "../lib/entity-codec";
import type { InterceptorEntry } from "../hooks/useInterceptors";
import type { WorkspaceDetailPayload } from "../widgets/RunDetail";

const originalFetch = globalThis.fetch;

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderPeek(type: Parameters<typeof PeekBody>[0]["type"], id: string) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={createTestQueryClient()}>
        <PeekBody type={type} id={id} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route every request by URL fragment; anything unmatched is a loud 500. */
function stubRoutes(routes: Array<[string, unknown]>): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, body] of routes) {
      if (url.includes(fragment)) return jsonResponse(body);
    }
    return new Response(JSON.stringify({ error: `unstubbed: ${url}` }), { status: 500 });
  }) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  localStorage.clear();
  // Belt-and-braces with the afterEach restore (PR #2983 R1): a test that dies
  // hard enough to skip teardown would otherwise leak the mock into whatever
  // file runs next, and cross-file fetch state is invisible where it lands.
  globalThis.fetch = originalFetch;
});

/**
 * Typed on purpose (mt#4069).
 *
 * `stubRoutes` takes its bodies as `unknown`, so a hand-written fixture is not
 * checked against the type the component actually consumes. An earlier version
 * of this entry omitted `families`, `familyState`, `coordinateGaps`,
 * `provenance` and `deliberatelyUnauthored`; `FamilyChips` fell past both of
 * its guard branches to `entry.families.map` and threw, React 18 unmounted the
 * whole root, and the pane came out BLANK rather than failing loudly — the
 * exact defect this task exists to remove, wearing the costume of a wiring bug.
 * Annotating the fixture moves that class to typecheck time.
 *
 * Deliberately `classified` with a real family: the two other `familyState`
 * values return before `FamilyChips` reaches `.map`, so an `unclassified`
 * fixture would route around the branch that broke.
 */
const INTERCEPTOR_ENTRY: InterceptorEntry = {
  guardName: "block-bulk-process-kill",
  description: "Denies a kill naming three or more PIDs.",
  failureClasses: [],
  provenance: [],
  sourceFile: null,
  stratum: null,
  subject: "trajectory",
  provenanceStatus: "implementation",
  coverageGaps: [],
  registered: true,
  undescribed: false,
  point: "PreToolUse",
  pointSource: "authored",
  trajectory: null,
  interventions: [],
  mechanism: null,
  role: null,
  coordinateGaps: [],
  families: ["guard"],
  familyState: "classified",
  deliberatelyUnauthored: false,
};

/**
 * Typed for the same reason as `INTERCEPTOR_ENTRY` above (PR #2983 R1).
 *
 * The first version of the session test stubbed a URL fragment that
 * `fetchWorkspaceDetail` never requests — it calls `/api/agents/:id`
 * (`RunDetail.tsx:200`). `stubRoutes` matches by substring, so the request fell
 * through to the mock's 500 branch and the body rendered `ErrorState`. The test
 * passed anyway, because its only assertion was that the RETIRED placeholder
 * copy was absent — and absent it was, from an error pane.
 *
 * That is the same defect class as the blank interceptor pane: an assertion
 * that cannot distinguish "the real body rendered" from "nothing useful
 * rendered". Every case in this file now asserts positively on content only the
 * real body emits.
 */
const WORKSPACE_DETAIL: WorkspaceDetailPayload = {
  session: {
    sessionId: "2154425b-0000-0000-0000-000000000000",
    shortId: "ws#12",
    taskId: "mt#4069",
    taskTitle: "A run",
    status: "IN-PROGRESS",
    liveness: "healthy",
    agentId: null,
    branch: "task/mt-4069",
    repoName: "edobry/minsky",
    repoUrl: null,
    createdAt: "2026-08-12T10:00:00.000Z",
    lastActivityAt: "2026-08-12T11:00:00.000Z",
    lastCommitHash: null,
    lastCommitMessage: null,
    commitCount: 0,
  },
  commits: [],
  pr: null,
  conversation: null,
  conversations: [],
};

describe("AT1 — each type mt#4069 added renders its real body", () => {
  test("ask renders the ask body, with no action controls", async () => {
    stubRoutes([
      [
        "/api/asks/",
        {
          ask: {
            id: "a902cba7-fd37-464a-842f-96fe38fe8bcc",
            kind: "direction.decide",
            state: "closed",
            title: "Production storage bucket",
            question: "Should I create the production storage bucket?",
            requestor: "agent",
            createdAt: "2026-08-12T10:00:00.000Z",
            windowMissedCount: 0,
            metadata: {},
            options: [{ label: "Hold off", value: "hold" }],
          },
        },
      ],
    ]);

    renderPeek("ask", "a902cba7-fd37-464a-842f-96fe38fe8bcc");

    // "From:" is one of AskDetail's own metadata labels — an adapter that
    // rendered something else, or nothing, does not produce it.
    await waitFor(() => expect(screen.getByText("From:")).toBeDefined());
    expect(screen.getByText(/Should I create the production storage bucket/)).toBeDefined();
    // Read-only: the pane owns closing, and a terminal ask has nothing to settle.
    expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /defer/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /escalate/i })).toBeNull();
  });

  test("interceptor renders the catalog entry's body", async () => {
    stubRoutes([
      [
        // The catalog is a registered backend widget: served from
        // /api/widget/interceptors/data, and wrapped in the widget envelope.
        // `fetchInterceptors` throws unless `state === "ok"`, so a bare payload
        // here renders the hook's error branch instead of the body.
        "/api/widget/interceptors/data",
        {
          state: "ok",
          payload: {
            population: 1,
            divergence: { declaredButNotDescribed: [], describedButNotDeclared: [] },
            entries: [INTERCEPTOR_ENTRY],
            failureClasses: {},
          },
        },
      ],
    ]);

    renderPeek("interceptor", "block-bulk-process-kill");

    await waitFor(() => {
      expect(screen.getByText("Denies a kill naming three or more PIDs.")).toBeDefined();
    });
    // A field label only the shared detail body emits.
    expect(screen.getByText("Interception point")).toBeDefined();
  });

  test("session renders the workspace overview body", async () => {
    // Must match what `fetchWorkspaceDetail` actually requests: `/api/agents/:id`.
    stubRoutes([["/api/agents/", WORKSPACE_DETAIL]]);

    renderPeek("session", "2154425b-0000-0000-0000-000000000000");

    // "Liveness" is a `WorkspaceOverviewBody` field label: neither the loading
    // state, the error state, nor the retired placeholder produces it.
    await waitFor(() => expect(screen.getByText("Liveness")).toBeDefined());
    expect(screen.getByText("task/mt-4069")).toBeDefined();
    expect(screen.queryByText(/does not have a peek body yet/)).toBeNull();
  });

  test("conversation renders the conversation overview body", async () => {
    stubRoutes([
      [
        "/api/conversation",
        {
          conversationMeta: {
            harness: "claude-code",
            cwd: "/tmp",
            startedAt: "2026-08-12T10:00:00.000Z",
            endedAt: null,
            lastActivityAt: "2026-08-12T11:00:00.000Z",
            turnCount: 12,
            relatedTaskIds: [],
            relatedPrNumbers: [],
          },
          workspace: null,
        },
      ],
    ]);

    renderPeek("conversation", "4917c847-36fa-4648-8ee9-6b2c73aa7019");

    // `ConversationMetaBody` is the no-workspace branch of the shared
    // OverviewTab — "Harness" is its label, produced by nothing else here.
    await waitFor(() => expect(screen.getByText("Harness")).toBeDefined());
    expect(screen.queryByText(/does not have a peek body yet/)).toBeNull();
  });
});

describe("AT1 — the open-as-page placeholder is retired", () => {
  test("no routable type renders the placeholder copy", () => {
    // A source-level complement to the render tests above: the string the
    // placeholder used is gone, so re-introducing it for a type that now has a
    // body would be a visible edit rather than a silent regression.
    const source = require("node:fs").readFileSync(
      require("node:url").fileURLToPath(new URL("./PeekBody.tsx", import.meta.url)),
      "utf8"
    );
    expect(source).not.toContain("does not have a peek body yet");
    expect(source).not.toContain("OpenAsPageOnly");
    // And the switch still handles every routable type — no fallthrough.
    for (const type of ROUTABLE_ENTITY_TYPES) {
      expect(source).toContain(`case "${type}":`);
    }
  });
});
