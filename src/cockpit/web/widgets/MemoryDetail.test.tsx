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
import { render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryDetailContent, type MemoriesDetailPayload } from "./MemoryDetail";
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
              { sessionId: "abcdef01-2345-6789-abcd-ef0123456789", title: "Some session", liveness: "healthy" },
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
