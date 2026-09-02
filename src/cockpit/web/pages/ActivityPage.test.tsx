/**
 * ActivityPage EventRow entity-reference adoption test (mt#3175).
 *
 * Shape 3: `event.relatedTaskId` becomes a link via the shared <EntityRef>
 * in children mode — the row's dense single-line layout (no inline label,
 * no status chip) is unchanged; hover still surfaces title + status.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EventRow, type SystemEvent } from "./ActivityPage";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function baseEvent(overrides: Partial<SystemEvent> = {}): SystemEvent {
  return {
    id: "evt-1",
    eventType: "task.status_changed",
    payload: { taskId: "mt#50", previousStatus: "TODO", newStatus: "READY" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderRow(event: SystemEvent) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EventRow event={event} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ActivityPage EventRow — Shape 3: event.relatedTaskId (mt#3175)", () => {
  test("renders as a link with the exact prior text (dense-row layout unchanged)", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return {
          ok: true,
          json: async () => ({ tasks: [{ id: "mt#50", title: "Some task", status: "READY" }] }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const { container } = renderRow(baseEvent({ relatedTaskId: "mt#50" }));
    const link = container.querySelector('a[href="/tasks/mt%2350"]');
    expect(link).not.toBeNull();
    // children mode: exact prior text (bare id), no inline "· title" suffix
    // that would grow the row's line height.
    expect(link?.textContent).toBe("mt#50");
    await waitFor(() => expect(link?.textContent).toBe("mt#50"));
  });

  test("absent relatedTaskId renders no task link", () => {
    global.fetch = mock(async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const { container } = renderRow(baseEvent());
    expect(container.querySelector('a[href^="/tasks/"]')).toBeNull();
  });
});

describe("ActivityPage EventRow — unknown event type fallback (mt#3240)", () => {
  test("renders a fallback row instead of crashing for an event type outside the client union", () => {
    global.fetch = mock(async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;

    // Simulates a real /api/activity response carrying an event type the page
    // has no bespoke copy for. The server's system_event_type enum has 30
    // members (measured 2026-09-02) and only 9 carry hand-written copy, so this
    // is the common case rather than an edge one — mt#4775 replaced the
    // 9-member client union with a derived default for exactly that reason.
    // fetchActivity's response is only type-asserted (`res.json() as
    // Promise<...>`), never runtime-validated, so this cast reproduces a
    // realistic wire shape, not a test-only artifact.
    const unknownEvent = baseEvent({
      eventType: "principal.poll_advanced" as SystemEvent["eventType"],
    });

    // Before the fix, eventStyle/eventSummary's exhaustive-looking switches
    // had no default case, fell through, and EventRow crashed reading
    // `style.badgeClass` off `undefined`. render() throws synchronously on a
    // render-time error, so a fix regression fails this test immediately.
    const { container } = renderRow(unknownEvent);

    // The derived default renders a readable label where the old fallback
    // printed `Unknown event (principal.poll_advanced)`. The anti-crash
    // guarantee mt#3240 shipped is unchanged and still the point of this test —
    // render() throws synchronously, so a regression fails here immediately.
    expect(container.textContent).toContain("Principal poll advanced");
    expect(container.textContent).not.toContain("Unknown event");
    const badge = container.querySelector("span.bg-muted");
    expect(badge).not.toBeNull();
  });
});
