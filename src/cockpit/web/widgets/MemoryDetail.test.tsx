/**
 * MemoryDetail entity-reference adoption test (mt#3175).
 *
 * Shape 3: `record.sourceSessionId` renders through the shared <EntityRef>
 * in children mode — the exact prior 8-char-truncated text is preserved
 * (visual regression check) but the field is now a real link with hover,
 * instead of dead monospace text.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryDetailContent, type MemoriesDetailPayload } from "./MemoryDetail";
import { ProjectProvider } from "../lib/project-context";
import type { MemoryRecord } from "@minsky/domain/memory/types";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function fallback(): Response {
  return jsonResponse({ state: "degraded", reason: "not mocked" });
}

function baseRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    type: "reference",
    name: "A memory",
    description: "desc",
    content: "content body",
    scope: "project",
    projectId: null,
    tags: [],
    sourceAgentId: null,
    sourceSessionId: null,
    confidence: null,
    supersededBy: null,
    metadata: null,
    associations: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    lastAccessedAt: null,
    accessCount: 0,
    ...overrides,
  };
}

function renderDetail(payload: MemoriesDetailPayload) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MemoryDetailContent payload={payload} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("MemoryDetail — Shape 3: record.sourceSessionId (mt#3175)", () => {
  test("renders as a linked <EntityRef>, preserving the 8-char-truncated visual", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/widget/agents/data")) {
        return jsonResponse({
          state: "ok",
          payload: {
            agents: [
              {
                sessionId: "abcdef01-2345-6789-abcd-ef0123456789",
                title: "Some session",
                liveness: "healthy",
              },
            ],
          },
        });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const record = baseRecord({ sourceSessionId: "abcdef01-2345-6789-abcd-ef0123456789" });
    const { container } = renderDetail({
      record,
      lineage: [],
      lineageTruncated: false,
      similar: [],
    });

    const link = container.querySelector('a[href="/agents/abcdef01-2345-6789-abcd-ef0123456789"]');
    expect(link).not.toBeNull();
    // children mode: visible text stays the exact prior truncated form,
    // regardless of whether the label ever resolves.
    expect(link?.textContent).toBe("abcdef01…");
    await waitFor(() => expect(link?.textContent).toBe("abcdef01…"));
  });

  test("absent sourceSessionId renders no session link", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const record = baseRecord({ sourceSessionId: null });
    const { container } = renderDetail({
      record,
      lineage: [],
      lineageTruncated: false,
      similar: [],
    });
    expect(container.querySelector('a[href^="/agents/"]')).toBeNull();
  });
});

describe("MemoryDetail — project label, not raw uuid (mt#4773 AT2)", () => {
  const PROJECT_ID = "3ac3d147-2b6f-4cf9-a52a-2b6e32d3c5fe";

  function renderWithProjects(payload: MemoriesDetailPayload) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ProjectProvider>
            <MemoryDetailContent payload={payload} />
          </ProjectProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  test("a project-scoped record shows the project's display name; the uuid is gone", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.includes("/api/projects")) {
        return jsonResponse({
          projects: [{ id: PROJECT_ID, slug: "edobry/minsky", displayName: "Minsky" }],
        });
      }
      return fallback();
    }) as unknown as typeof fetch;

    renderWithProjects({
      record: baseRecord({ projectId: PROJECT_ID }),
      lineage: [],
      lineageTruncated: false,
      similar: [],
    });

    await waitFor(() => expect(screen.getByText("Minsky")).toBeTruthy());
    expect(screen.queryByText(PROJECT_ID)).toBeNull();
  });

  test("an id the shell cannot resolve keeps the uuid as the last-resort fallback", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    // No provider wrap: outside the shell there is no project list, so the
    // detail surface degrades to the identifier it has rather than hiding it.
    renderDetail({
      record: baseRecord({ projectId: PROJECT_ID }),
      lineage: [],
      lineageTruncated: false,
      similar: [],
    });
    expect(screen.getByText(PROJECT_ID)).toBeTruthy();
  });
});

describe("MemoryDetail — clickable tags (mt#4763)", () => {
  test("a tag links to the /memories facet-filtered view", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const record = baseRecord({ tags: ["handoff", "cockpit"] });
    const { container } = renderDetail({
      record,
      lineage: [],
      lineageTruncated: false,
      similar: [],
    });
    const link = container.querySelector('a[href="/memories?mem_f_tags=handoff"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("handoff");
  });
});

describe("MemoryDetail — entity-shaped tags are deeplinks, not filters (PR #3500 R2 BLOCKING)", () => {
  test("an mt#NNNN tag renders as a task deeplink instead of a filter link", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const record = baseRecord({ tags: ["mt#4749", "handoff"] });
    const { container } = renderDetail({
      record,
      lineage: [],
      lineageTruncated: false,
      similar: [],
    });
    const taskLink = container.querySelector('a[href="/tasks/mt%234749"]');
    expect(taskLink).not.toBeNull();
    expect(taskLink?.textContent).toBe("mt#4749");
    // Not ALSO rendered as a filter link to the same tag.
    expect(container.querySelector('a[href="/memories?mem_f_tags=mt%234749"]')).toBeNull();
    // A non-entity-shaped tag on the same record is unaffected.
    expect(container.querySelector('a[href="/memories?mem_f_tags=handoff"]')).not.toBeNull();
  });

  test("a PR#NNNN tag renders as a changeset deeplink instead of a filter link", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const record = baseRecord({ tags: ["PR#3000"] });
    const { container } = renderDetail({
      record,
      lineage: [],
      lineageTruncated: false,
      similar: [],
    });
    const link = container.querySelector('a[href="/changeset/3000"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("PR#3000");
  });
});

describe("MemoryDetail — ADR-012 association rendering (mt#4763 AT7)", () => {
  test("a tracksTask association renders as a clickable task deeplink", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const record = baseRecord({ associations: { tracksTask: ["mt#4749"] } });
    const { container } = renderDetail({
      record,
      lineage: [],
      lineageTruncated: false,
      similar: [],
    });
    const link = container.querySelector('a[href="/tasks/mt%234749"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("mt#4749");
  });

  test("a relatedTask association also renders as a clickable task deeplink", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const record = baseRecord({ associations: { relatedTask: ["mt#1034"] } });
    const { container } = renderDetail({
      record,
      lineage: [],
      lineageTruncated: false,
      similar: [],
    });
    expect(container.querySelector('a[href="/tasks/mt%231034"]')).not.toBeNull();
  });

  test("a citedInReview (PR) association routes via the changeset codec on the bare PR number", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const record = baseRecord({ associations: { citedInReview: ["PR#1243"] } });
    const { container } = renderDetail({
      record,
      lineage: [],
      lineageTruncated: false,
      similar: [],
    });
    const link = container.querySelector('a[href="/changeset/1243"]');
    expect(link).not.toBeNull();
    // Children mode: the visible text stays the ADR-012 canonical form, not the bare route id.
    expect(link?.textContent).toBe("PR#1243");
  });

  test("an association type with no routable target kind (originatesRule) renders plain monospace text", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const record = baseRecord({ associations: { originatesRule: ["hook-files.mdc"] } });
    const { container } = renderDetail({
      record,
      lineage: [],
      lineageTruncated: false,
      similar: [],
    });
    expect(container.textContent).toContain("hook-files.mdc");
    expect(container.querySelector("a")).toBeNull();
  });
});
