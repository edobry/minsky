/**
 * Rail collapse tests (mt#3700) — the acceptance tests for the icon rail.
 *
 * Renders the real `Rail` rather than the toggle in isolation: the thing under
 * test is that ONE piece of state reaches the header, the nav, the create
 * action, and the footer coherently, which is wiring, not a component.
 *
 * The central assertion shape throughout is "the accessible name survives, the
 * visible text does not" — an icon rail that drops the label from BOTH is not a
 * collapsed rail, it is an unlabelled one, so `getByRole(…, { name })` finding
 * the link is half the assertion and `textContent` being empty is the other.
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
  try {
    localStorage.clear();
  } catch {
    /* intentional-swallow: a storage-less environment is the AT4 case anyway */
  }
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (url: unknown) => {
    const href = String(url);
    if (href.includes("/api/health")) {
      return new Response(JSON.stringify({ commit: "abc1234" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ state: "ok", payload: { totalPending: 3 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  stubProjectsRoute();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  try {
    localStorage.clear();
  } catch {
    /* intentional-swallow: see above */
  }
});

/** The desktop rail's collapse control, in whichever state it is currently in. */
function toggle(): HTMLElement {
  return screen.queryByRole("button", { name: "Collapse sidebar" }) != null
    ? screen.getByRole("button", { name: "Collapse sidebar" })
    : screen.getByRole("button", { name: "Expand sidebar" });
}

describe("Rail — collapse (AT1: labels drop, accessible names survive)", () => {
  test("collapsing hides the visible link text but keeps each link reachable by name", () => {
    renderRail();

    // Expanded: the label is a text node inside the link.
    expect(screen.getByRole("link", { name: "Tasks" }).textContent).toContain("Tasks");
    expect(screen.getByRole("button", { name: "New conversation" }).textContent).toContain(
      "New conversation"
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    // Collapsed: still found BY NAME (so the name survived), but with no text.
    expect(screen.getByRole("link", { name: "Tasks" }).textContent).toBe("");
    expect(screen.getByRole("link", { name: "Changesets" }).textContent).toBe("");
    expect(screen.getByRole("link", { name: "Settings" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "New conversation" }).textContent).toBe("");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    // ...and expanding puts them back.
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("link", { name: "Tasks" }).textContent).toContain("Tasks");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  test("the attention digest keeps its pending count in the accessible name when collapsed", async () => {
    renderRail();

    // The count arrives from the mocked widget fetch; wait for it in the
    // EXPANDED state first so the collapsed assertion is about the collapse and
    // not about the query still being in flight.
    await screen.findByRole("link", { name: "Attention — 3 pending" });

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    const digest = screen.getByRole("link", { name: "Attention — 3 pending" });
    // The number is the one piece of text the collapsed rail keeps — the slot is
    // algedonic, so a rail that narrows must not take the count dark with it.
    expect(digest.textContent).toContain("3");
  });

  test("the toggle's aria-controls resolves to the aside it collapses (PR #2629 R1)", () => {
    renderRail();
    const aside = screen.getByRole("complementary", { name: "Primary navigation" });

    // A dangling IDREF fails silently — it is indistinguishable from a correct
    // one in the markup, and only assistive tech notices. So the assertion is
    // that the reference RESOLVES, not merely that the attribute is present.
    const controls = toggle().getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls as string)).toBe(aside);

    // ...and it still resolves after the collapse, when it matters most.
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(document.getElementById(toggle().getAttribute("aria-controls") as string)).toBe(aside);
  });

  test("the aside narrows from w-60 to w-14", () => {
    renderRail();
    const aside = screen.getByRole("complementary", { name: "Primary navigation" });

    expect(aside.className).toContain("w-60");
    expect(aside.className).not.toContain("w-14");

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(aside.className).toContain("w-14");
    expect(aside.className).not.toContain("w-60");
  });
});

describe("Rail — collapse (AT2: the ⌘B chord)", () => {
  test("⌘B toggles the rail", () => {
    renderRail();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  test("⌘B is suppressed while focus is in a text-entry surface", () => {
    renderRail();
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    fireEvent.keyDown(textarea, { key: "b", metaKey: true });

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    textarea.remove();
  });
});

describe("Rail — collapse (AT3/AT4: persistence)", () => {
  test("the collapsed state survives a remount", () => {
    const first = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    first.unmount();

    renderRail();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("link", { name: "Tasks" }).textContent).toBe("");
  });

  test("expanding again clears the persisted state", () => {
    const first = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    first.unmount();

    renderRail();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  test("a throwing localStorage renders the expanded rail instead of crashing", () => {
    // Replacing the global here (rather than injecting) is deliberate: the point
    // is that `Rail`'s own zero-arg call site degrades, and that call site reads
    // the global. The injectable-storage path is unit-tested in
    // `lib/rail-collapse.test.ts`; this asserts the wiring around it.
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem() {
          throw new Error("storage disabled");
        },
        setItem() {
          throw new Error("storage disabled");
        },
        removeItem() {
          throw new Error("storage disabled");
        },
        clear() {
          throw new Error("storage disabled");
        },
      },
    });

    try {
      renderRail();
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByRole("link", { name: "Tasks" }).textContent).toContain("Tasks");
    } finally {
      if (original) {
        Object.defineProperty(globalThis, "localStorage", original);
      } else {
        // @ts-expect-error — removing a global we defined above; there was no
        // original descriptor to restore, so deletion IS the restore.
        delete globalThis.localStorage;
      }
    }
  });
});

describe("Rail — collapse (AT5: the mobile drawer is unaffected)", () => {
  test("the drawer renders the expanded nav even while the desktop rail is collapsed", async () => {
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog");

    // The drawer takes no `collapsed`, so its links keep their text. Scoped to
    // the dialog because Radix aria-hides the rest of the document while the
    // modal is open (the same reason Rail.newConversation.test.tsx scopes).
    expect(within(drawer).getByRole("link", { name: "Tasks" }).textContent).toContain("Tasks");
    expect(within(drawer).getByRole("button", { name: "New conversation" }).textContent).toContain(
      "New conversation"
    );
    // The drawer has no collapse control — there is no width to reclaim in a
    // slide-in that is already a deliberate gesture.
    expect(within(drawer).queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
  });
});
