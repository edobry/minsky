/**
 * Rail × new-conversation regression test (mt#3464, PR #2477 R1).
 *
 * Pins the mobile-drawer error surface. The first implementation closed the
 * drawer on click; because the desktop rail is `hidden` below `md`, its copy
 * of the alert renders into a display:none subtree, so a failed launch had NO
 * visible error surface on a narrow viewport — the exact silent failure the
 * alert exists to prevent.
 *
 * This renders the real `Rail` (not the button in isolation) because the
 * defect lived in the wiring between them, not in either one alone.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Rail } from "./Rail";
import { NewConversationProvider } from "../hooks/useNewConversation";
import { ProjectProvider } from "../lib/project-context";
import { stubProjectsRoute } from "../lib/test-support/projects";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

function renderRail() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={["/tasks"]}>
        {/* ProjectProvider is Rail's other required ancestor — `ProjectSelector`
            throws without it, the same house convention `useNewConversation`
            follows. */}
        <ProjectProvider>
          <NewConversationProvider>
            <Rail />
          </NewConversationProvider>
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (url: unknown) => {
    const href = String(url);
    if (href.includes("/api/driven-session")) {
      // Every launch in this file fails — the failure surface IS the subject.
      return new Response(JSON.stringify({ error: "daemon cwd is not a git repository" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (href.includes("/api/health")) {
      return new Response(JSON.stringify({ commit: "abc1234" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ state: "ok", payload: { totalPending: 0 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  stubProjectsRoute();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/**
 * Open the mobile drawer and return it. Queries are scoped to the returned
 * dialog rather than counting matches document-wide: Radix marks the rest of
 * the document `aria-hidden` while the modal is open, so role queries stop
 * seeing the desktop rail's copy entirely. Scoping says what we mean anyway —
 * "the drawer has one" — instead of asserting a total that depends on Radix's
 * aria-hiding behavior.
 */
async function openDrawer(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  return await screen.findByRole("dialog");
}

describe("Rail — new-conversation control", () => {
  test("renders in the desktop rail, and in the mobile drawer once opened", async () => {
    renderRail();

    // Drawer closed: the desktop rail's copy is the only one mounted.
    expect(screen.getByRole("button", { name: "New conversation" })).toBeDefined();

    const drawer = await openDrawer();
    expect(within(drawer).getByRole("button", { name: "New conversation" })).toBeDefined();
  });

  test("a failed launch from the OPEN drawer leaves the drawer open and the error visible", async () => {
    renderRail();
    const drawer = await openDrawer();

    fireEvent.click(within(drawer).getByRole("button", { name: "New conversation" }));

    // The error must be visible from INSIDE the drawer. Before PR #2477 R1 the
    // click closed the drawer, and the desktop rail's copy of this alert is
    // `hidden` below `md` — so the failure was invisible on mobile.
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toBe("daemon cwd is not a git repository");

    // ...and the drawer is still open around it.
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(within(drawer).getByRole("button", { name: "New conversation" })).toBeDefined();
  });
});
