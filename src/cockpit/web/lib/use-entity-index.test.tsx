/**
 * Tests for the label channel added to use-entity-index.ts (mt#3174):
 * batching (K references -> 1 request) and failure tolerance for the task
 * label channel. Per-type label CONTENT (session/ask/memory/changeset/
 * conversation) is exercised end to end through `<EntityRef>` in
 * `../components/EntityRef.test.tsx` — this file covers the batching
 * mechanics that are specific to `use-entity-index.ts`'s `TaskMetaBatcher`
 * and are hard to observe from a single-component test.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EntityRef } from "../components/EntityRef";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("Task label channel — batching (mt#3174 acceptance test)", () => {
  test("K simultaneously-mounted <EntityRef type=\"task\"> references issue ONE /api/tasks/meta request, not K", async () => {
    const metaCalls: string[] = [];
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        metaCalls.push(url);
        return jsonResponse({
          tasks: [
            { id: "mt#1", title: "One", status: "TODO" },
            { id: "mt#2", title: "Two", status: "READY" },
            { id: "mt#3", title: "Three", status: "DONE" },
          ],
        });
      }
      // Every EntityRef also mounts the 5 non-task label queries
      // unconditionally (useResolvedEntityLabel calls useEntityLabels
      // regardless of type) — degrade those safely, they're not under test
      // here.
      return jsonResponse({ state: "degraded", reason: "not mocked" });
    }) as unknown as typeof fetch;

    const client = createTestQueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <EntityRef type="task" id="mt#1" />
          <EntityRef type="task" id="mt#2" />
          <EntityRef type="task" id="mt#3" />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(container.textContent).toContain("One");
      expect(container.textContent).toContain("Two");
      expect(container.textContent).toContain("Three");
    });

    // The batcher coalesces all three ids into a single request.
    expect(metaCalls.length).toBe(1);
    // And that one request actually carried all three ids (not just the
    // first mounted instance's).
    const url = new URL(metaCalls[0] as string, "http://localhost");
    // URLSearchParams.get() decodes the retrieved value, so the recovered
    // ids are back in display form (percent-encoding is only on the wire).
    const ids = (url.searchParams.get("ids") ?? "").split(",");
    expect(ids.sort()).toEqual(["mt#1", "mt#2", "mt#3"].sort());
  });

  test("a failing task-meta endpoint degrades every reference to a bare linked id — no crash", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return jsonResponse({ error: "unavailable" }, false);
      }
      return jsonResponse({ state: "degraded", reason: "not mocked" });
    }) as unknown as typeof fetch;

    const client = createTestQueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <EntityRef type="task" id="mt#10" />
          <EntityRef type="task" id="mt#11" />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Give the (failing) batched fetch a tick to settle.
    await new Promise((r) => setTimeout(r, 0));

    const anchors = container.querySelectorAll("a");
    expect(anchors.length).toBe(2);
    const texts = Array.from(anchors).map((a) => a.textContent);
    expect(texts).toEqual(["mt#10", "mt#11"]);
  });
});
