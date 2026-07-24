/**
 * TaskGraph selected-node-panel entity-reference adoption test (mt#3175).
 *
 * Shape 3: `node.id` becomes a link via the shared <EntityRef> (children
 * mode — link only, exact prior text preserved). `node.label` (title) and
 * the status chip render exactly as before — no duplicated title.
 *
 * Tests SelectedPanel directly rather than mounting the full TaskGraph
 * (react-flow canvas rendering is unreliable under jsdom/happy-dom; the
 * panel is the only piece this task's change touches).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SelectedPanel } from "./TaskGraph";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function renderPanel(node: { id: string; label: string; status: string } | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SelectedPanel node={node} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TaskGraph SelectedPanel — Shape 3: node.id (mt#3175)", () => {
  test("node.id renders as a link; title and status are NOT duplicated", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return { ok: true, json: async () => ({ tasks: [{ id: "mt#42", title: "Fix the bug", status: "READY" }] }) } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const { container } = renderPanel({ id: "mt#42", label: "Fix the bug", status: "READY" });

    const link = container.querySelector('a[href="/tasks/mt%2342"]');
    expect(link).not.toBeNull();
    // children mode: link text is the bare id, never `id · label`.
    expect(link?.textContent).toBe("mt#42");

    // The title renders exactly once (from node.label, not duplicated by the link).
    const titleOccurrences = (container.textContent?.match(/Fix the bug/g) ?? []).length;
    expect(titleOccurrences).toBe(1);

    // Status chip renders exactly once (from the existing status badge, not
    // duplicated by EntityRef — which would only add a status chip in its
    // default no-children mode, not used here).
    const statusOccurrences = (container.textContent?.match(/READY/g) ?? []).length;
    expect(statusOccurrences).toBe(1);

    // Give the label-resolution query a tick — even once it resolves, the
    // trigger's visible text must stay the bare id (mt#3165 "Hover is
    // supplementary").
    await waitFor(() => expect(link?.textContent).toBe("mt#42"));
  });

  test("null node renders nothing", () => {
    const { container } = renderPanel(null);
    expect(container.textContent).toBe("");
  });
});
