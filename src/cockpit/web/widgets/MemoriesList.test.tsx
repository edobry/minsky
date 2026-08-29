/**
 * MemoriesList entity-reference adoption test (mt#3175).
 *
 * Shape 2: `rec.description`'s truncated single-line row cell now linkifies
 * via the inline-only `<LinkifiedText>` path (never `<Prose>` — block
 * Markdown would break the single-line truncation this row depends on). The
 * `truncate block` wrapper and its `title` attribute are unchanged.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoriesList } from "./MemoriesList";
import type { MemoryRecord } from "@minsky/domain/memory/types";
import { ProjectProvider } from "../lib/project-context";

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
    description: "See mt#77 for context",
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

function renderList(records: MemoryRecord[]) {
  global.fetch = mock(async (url: string) => {
    if (url.startsWith("/api/widget/memories-list/data")) {
      return jsonResponse({ state: "ok", payload: { records, total: records.length } });
    }
    if (url.startsWith("/api/tasks/ids")) {
      return jsonResponse({ ids: ["mt#77"] });
    }
    return jsonResponse({ state: "degraded", reason: "not mocked" });
  }) as unknown as typeof fetch;

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectProvider>
          <MemoriesList />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("MemoriesList — Shape 2: rec.description (mt#3175)", () => {
  test("an entity ref in the description linkifies without breaking the truncated single-line cell", async () => {
    const { container } = renderList([baseRecord()]);

    await waitFor(() => {
      const cell = container.querySelector("td.max-w-\\[220px\\]");
      expect(cell).not.toBeNull();
      expect(cell?.querySelector('a[href="/tasks/mt%2377"]')).not.toBeNull();
    });

    // Layout preserved: the truncate/title wrapper span is unchanged.
    const cell = container.querySelector("td.max-w-\\[220px\\]");
    const span = cell?.querySelector("span.truncate.block");
    expect(span).not.toBeNull();
    expect(span?.getAttribute("title")).toBe("See mt#77 for context");
  });

  test("a description with no entity refs renders as plain truncated text (unchanged)", async () => {
    const { container } = renderList([baseRecord({ description: "no refs here" })]);
    await waitFor(() => {
      expect(container.textContent).toContain("no refs here");
    });
    expect(container.querySelector("td.max-w-\\[220px\\] a")).toBeNull();
  });
});
