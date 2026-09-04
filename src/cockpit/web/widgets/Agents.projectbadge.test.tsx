/**
 * Agents.tsx per-row project badge (mt#4773 AT1).
 *
 * The agents payload has carried `projectId` per row since mt#4732; the UI
 * dropped it until mt#4773. These tests pin the row-level affordance to the
 * same when-to-show rule task/changeset rows use (mt#4729,
 * `shouldShowProjectIndicator`): badge in the all-projects view with 2+
 * known projects, suppressed under an explicit selection or a single-project
 * shell.
 *
 * Harness mirrors `Agents.peek.test.tsx` (fetch stubs for the widget payload
 * + the shell's /api/projects), minus the WebSocket scaffolding this file
 * never touches.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Agents, type AgentRow } from "./Agents";
import { ProjectProvider } from "../lib/project-context";

const originalFetch = globalThis.fetch;

const MINSKY_ID = "3ac3d147-0000-0000-0000-000000000001";
const PEEZOMBIE_ID = "3ac3d147-0000-0000-0000-000000000002";

const TWO_PROJECTS = [
  { id: MINSKY_ID, slug: "edobry/minsky", displayName: "Minsky" },
  { id: PEEZOMBIE_ID, slug: "edobry/peezombie.me", displayName: null },
];

function row(overrides: Partial<AgentRow> & Pick<AgentRow, "sessionId">): AgentRow {
  return {
    kind: "dispatched-agent",
    title: overrides.sessionId,
    liveness: "healthy",
    taskId: null,
    taskTitle: null,
    prNumber: null,
    prStatus: null,
    lastActivityAt: "2026-08-31T00:00:00Z",
    agentId: null,
    conversationId: null,
    cwd: null,
    subagents: [],
    model: null,
    driven: null,
    attachState: null,
    interfaceBinding: { kind: "unbound", lastObservedAt: "2026-08-31T00:00:00Z" },
    ...overrides,
  };
}

function stubNetwork(agents: AgentRow[], projects: typeof TWO_PROJECTS) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/widget/agents/data")) {
      return new Response(
        JSON.stringify({ state: "ok", payload: { agents, totalCount: agents.length } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.includes("/api/health")) {
      return new Response(JSON.stringify({ transcriptWatcher: { activeSessions: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/asks")) {
      return new Response(JSON.stringify({ asks: [], total: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/projects")) {
      return new Response(JSON.stringify({ projects }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function renderAgents() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProjectProvider>
          <Agents />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  try {
    localStorage.removeItem("cockpit.project.v1");
  } catch {
    /* happy-dom always has localStorage; defensive for other runners */
  }
});

describe("Agents per-row project badge (mt#4773)", () => {
  test("AT1: all-projects view with a two-project fixture shows per-row project identity", async () => {
    stubNetwork(
      [
        row({ sessionId: "minsky-run", projectId: MINSKY_ID }),
        row({ sessionId: "pz-run", projectId: PEEZOMBIE_ID }),
      ],
      TWO_PROJECTS
    );
    renderAgents();

    // displayName where the shell has one, slug fallback where it does not —
    // projectLabelById's contract.
    await waitFor(() => {
      expect(screen.getByText("Minsky")).toBeTruthy();
      expect(screen.getByText("edobry/peezombie.me")).toBeTruthy();
    });
  });

  test("no badge for a row whose projectId the shell cannot resolve", async () => {
    stubNetwork(
      [
        row({
          sessionId: "unknown-project-run",
          projectId: "00000000-0000-0000-0000-00000000dead",
        }),
      ],
      TWO_PROJECTS
    );
    renderAgents();

    await waitFor(() => expect(screen.getByText("unknown-project-run")).toBeTruthy());
    // A raw uuid must never surface as a row label (the illegibility mt#4773
    // exists to remove) — an unresolvable id renders no badge at all.
    expect(screen.queryByText(/00000000-0000-0000-0000-00000000dead/)).toBeNull();
  });

  test("suppresses the badge when a single project is known", async () => {
    stubNetwork([row({ sessionId: "solo-run", projectId: MINSKY_ID })], [TWO_PROJECTS[0]!]);
    renderAgents();

    await waitFor(() => expect(screen.getByText("solo-run")).toBeTruthy());
    expect(screen.queryByText("Minsky")).toBeNull();
  });
});
