/**
 * MemorySearch entity-reference adoption test (mt#3175).
 *
 * Shape 2: `record.description`'s truncated single-line search-result
 * snippet now linkifies via the inline-only `<LinkifiedText>` path (never
 * `<Prose>` — block Markdown would break the single-line truncation this
 * snippet depends on). The `truncate` wrapper and its `title` attribute are
 * unchanged.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemorySearch } from "./MemorySearch";
import type { MemoryRecord } from "@minsky/domain/memory/types";
import { ProjectProvider } from "../lib/project-context";
import { stubProjectsRoute } from "../lib/test-support/projects";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function baseRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    type: "reference",
    name: "A memory",
    description: "See mt#88 for context",
    content: "content",
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

async function renderAndSearch(records: MemoryRecord[]) {
  global.fetch = mock(async (url: string) => {
    if (url.startsWith("/api/widget/memories-search/data")) {
      return jsonResponse({
        state: "ok",
        payload: {
          results: records.map((record) => ({ record, score: 0.9 })),
          backend: "lexical",
          degraded: false,
          query: "x",
        },
      });
    }
    if (url.startsWith("/api/tasks/ids")) {
      return jsonResponse({ ids: ["mt#88"] });
    }
    return jsonResponse({ state: "degraded", reason: "not mocked" });
  }) as unknown as typeof fetch;
  stubProjectsRoute();

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectProvider>
          <MemorySearch />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const input = result.container.querySelector('input[type="search"]') as HTMLInputElement;
  fireEvent.change(input, { target: { value: "x" } });
  // Debounce is 300ms — advance past it.
  await new Promise((r) => setTimeout(r, 350));
  return result;
}

describe("MemorySearch — Shape 2: record.description snippet (mt#3175)", () => {
  test("an entity ref in the snippet linkifies without breaking the truncated single-line layout", async () => {
    const { container } = await renderAndSearch([baseRecord()]);

    await waitFor(() => {
      const snippet = container.querySelector("p.truncate");
      expect(snippet).not.toBeNull();
      expect(snippet?.querySelector('a[href="/tasks/mt%2388"]')).not.toBeNull();
    });
    const snippet = container.querySelector("p.truncate");
    expect(snippet?.getAttribute("title")).toBe("See mt#88 for context");
  });

  test("a snippet with no entity refs renders as plain truncated text (unchanged)", async () => {
    const { container } = await renderAndSearch([baseRecord({ description: "no refs here" })]);
    await waitFor(() => {
      expect(container.textContent).toContain("no refs here");
    });
    expect(container.querySelector("p.truncate a")).toBeNull();
  });
});
