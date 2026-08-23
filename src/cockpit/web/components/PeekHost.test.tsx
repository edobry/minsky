/**
 * Tests for the entity side peek (mt#3694) — EntityRef click → PeekHost.
 *
 * These exercise the seam that actually matters and that the pure codec tests
 * (`lib/peek-codec.test.ts`) cannot reach: a real click on a real `EntityRef`
 * inside a router, and what the shell does with it. The task's acceptance
 * tests are cited by number in the test names.
 *
 * The strongest assertion here is AT1's second half — that peeking does NOT
 * open a tab. That is the whole reason a peek could not be built as a route
 * change, and it is invisible to every other check in the suite.
 */
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EntityRef } from "./EntityRef";
import { PeekHost } from "./PeekHost";
import { TabsProvider } from "../lib/tabs";
import { PEEKABLE_WITH_BODY } from "./PeekBody";
import { ROUTABLE_ENTITY_TYPES } from "../lib/entity-codec";

const originalFetch = global.fetch;

beforeEach(() => {
  localStorage.clear();
  // Every label / detail lookup degrades safely — these tests are about the
  // peek mechanism, not about any particular entity's payload.
  global.fetch = mock(
    async () => ({ ok: true, json: async () => ({ state: "degraded", reason: "not mocked" }) })
  ) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  localStorage.clear();
});

/** Surfaces the live location so tests can assert the URL contract directly. */
function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">{`${location.pathname}${location.search}`}</output>
  );
}

function renderShell(initialEntries: string[] = ["/tasks/mt%232370"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>
        <TabsProvider>
          <Routes>
            <Route
              path="*"
              element={
                <div>
                  <h1>Underlying page</h1>
                  <EntityRef type="task" id="mt#3694" />
                  <EntityRef type="memory" id="fbcb360f-fe0e-402d-9b35-7e3c2b2ab59a" />
                  <LocationProbe />
                  <PeekHost />
                </div>
              }
            />
          </Routes>
        </TabsProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function taskRef() {
  return screen.getAllByRole("link").find((el) => el.textContent?.includes("mt#3694"))!;
}
function memoryRef() {
  return screen.getAllByRole("link").find((el) => el.textContent?.includes("fbcb360f"))!;
}

describe("AT1 — an ordinary click peeks without navigating or opening a tab", () => {
  test("renders a pane, leaves the underlying page mounted, and adds no tab", async () => {
    renderShell();
    expect(screen.queryByTestId("peek-host")).toBeNull();

    fireEvent.click(taskRef(), { button: 0 });

    const pane = await screen.findByTestId("peek-pane");
    expect(pane.getAttribute("data-peek-type")).toBe("task");
    expect(pane.getAttribute("data-peek-id")).toBe("mt#3694");

    // The page behind is still mounted — this is the point of a peek.
    expect(screen.getByText("Underlying page")).toBeTruthy();

    // ...and the pathname never changed, which is WHY it is still mounted and
    // why TabsProvider's open-on-visit effect (keyed on pathname) cannot fire.
    // The id is percent-encoded inside the value AND by URLSearchParams, so
    // `mt#3694` → `mt%233694` → `mt%25233694`. AT3 below loads this exact URL
    // back and gets the same pane, which is what makes the double pass safe.
    expect(screen.getByTestId("location").textContent).toBe(
      "/tasks/mt%232370?peek=task%3Amt%25233694"
    );

    // The persisted tab set is untouched. A route change would have added one.
    expect(localStorage.getItem("minsky.cockpit.tabs")).toBeNull();
  });
});

describe("AT2 — Esc closes the peek and clears the parameter", () => {
  test("removes the pane and leaves no ?peek= residue in the URL", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("peek-pane")).toBeNull());
    expect(screen.getByTestId("location").textContent).toBe("/tasks/mt%232370");
  });
});

describe("AT2b — focus returns to the link that opened the peek", () => {
  // Regression test for PR #2942 R2. The PR body claimed focus-return was
  // inherited from Radix, quoting `context.triggerRef.current?.focus()` in the
  // non-modal branch. That call is real but unreachable here: `triggerRef` is
  // populated by a `Dialog.Trigger`, and these panes are CONTROLLED with no
  // Trigger, so the optional chain no-ops and focus lands on document.body.
  // Nothing throws and nothing warns, which is why only an assertion catches it.
  test("Esc restores focus to the originating anchor, not document.body", async () => {
    renderShell();
    const opener = taskRef();
    fireEvent.click(opener, { button: 0 });
    await screen.findByTestId("peek-pane");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("peek-pane")).toBeNull());

    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  test("the close button also restores focus to the opener", async () => {
    renderShell();
    const opener = taskRef();
    fireEvent.click(opener, { button: 0 });
    await screen.findByTestId("peek-pane");

    fireEvent.click(screen.getByLabelText("Close mt#3694"));
    await waitFor(() => expect(screen.queryByTestId("peek-pane")).toBeNull());

    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  test("a held pair unwinds one pane per Esc, landing focus on the LAST opener", async () => {
    // Semantics worth stating because they are a choice, not a fallout: each
    // open overwrites the remembered opener, so unwinding a held assembly
    // returns focus to the ref clicked MOST RECENTLY, not the one that started
    // the assembly. That is where the operator's attention last was, and
    // keeping a stack of openers to walk back through would be a second trail
    // competing with browser Back.
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");
    const lastOpener = memoryRef();
    fireEvent.click(lastOpener, { button: 0, shiftKey: true });
    await waitFor(() => expect(screen.getAllByTestId("peek-pane")).toHaveLength(2));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.getAllByTestId("peek-pane")).toHaveLength(1));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("peek-pane")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(lastOpener));
  });

  // NOT asserted here, deliberately: that focus is not restored EARLY, on the
  // first of the two Esc presses. happy-dom does not move focus into the pane
  // on open, so `document.activeElement` remains the clicked anchor for the
  // whole sequence — an assertion that focus "has not yet returned to the
  // opener" would pass whether or not the code restored early, which makes it
  // noise rather than a check (a probe that cannot fail verifies nothing).
  // The guard itself is the `panes.length === 0 && hadPanes.current` condition
  // in PeekHost; the two tests above cover that it fires when the assembly
  // empties, and this one covers that a held pair unwinds one pane at a time.
});

describe("AT3 — a peeked URL is addressable", () => {
  test("loading a URL that already carries ?peek= opens that pane", async () => {
    renderShell(["/tasks/mt%232370?peek=task%3Amt%25233694"]);
    const pane = await screen.findByTestId("peek-pane");
    expect(pane.getAttribute("data-peek-id")).toBe("mt#3694");
  });
});

describe("AT4 — the promote gesture still navigates", () => {
  test("Cmd-click is left to the browser rather than peeked", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0, metaKey: true });
    // No pane, and no peek param — the anchor's own navigation is untouched.
    expect(screen.queryByTestId("peek-pane")).toBeNull();
    expect(screen.getByTestId("location").textContent).not.toContain("peek=");
  });

  test("middle-click is left to the browser too", () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 1 });
    expect(screen.queryByTestId("peek-pane")).toBeNull();
  });
});

describe("AT5 — clicking a ref REPLACES, holding makes the next one land beside", () => {
  test("a second ordinary click replaces the pane rather than stacking", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");

    fireEvent.click(memoryRef(), { button: 0 });

    await waitFor(() => {
      const panes = screen.getAllByTestId("peek-pane");
      expect(panes).toHaveLength(1);
      expect(panes[0]?.getAttribute("data-peek-type")).toBe("memory");
    });

    // Assert the URL too, not just the pane count: "replaced the task pane"
    // and "never had a task pane" both render one memory pane, so the count
    // alone does not discriminate between a working replace and a controller
    // that lost its state between clicks.
    // Scoped to the parameter, not the whole URL — the pathname here is
    // `/tasks/...`, so a bare "task" substring check matches the page we are
    // peeking FROM and would pass no matter what the peek did.
    const loc = screen.getByTestId("location").textContent ?? "";
    expect(loc).toContain("peek=memory");
    expect(loc).not.toContain("peek=task");
  });

  test("shift-click holds the current pane so the next opens beside it", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");

    // Shift-click is the hold gesture: it keeps what is on screen and opens
    // the new entity alongside it.
    fireEvent.click(memoryRef(), { button: 0, shiftKey: true });

    await waitFor(() => {
      const panes = screen.getAllByTestId("peek-pane");
      expect(panes).toHaveLength(2);
      expect(panes[0]?.getAttribute("data-peek-type")).toBe("task");
      expect(panes[0]?.getAttribute("data-peek-held")).toBe("true");
      expect(panes[1]?.getAttribute("data-peek-type")).toBe("memory");
    });
  });
});

describe("AT6 — every routable type is accounted for", () => {
  test("the with-body list is a subset of the routable types, with no unknown entries", () => {
    for (const type of PEEKABLE_WITH_BODY) {
      expect(ROUTABLE_ENTITY_TYPES).toContain(type);
    }
  });

  test("PEEKABLE_WITH_BODY pins the current split so a new adapter is a deliberate edit", () => {
    // This is the coverage ratchet the spec asks for. It fails when a routable
    // type is ADDED (the total moves) or when an adapter lands without being
    // declared — either way, the gap surfaces here rather than as a blank pane.
    //
    // mt#4069 closed the split: every routable type now has a body, so the two
    // lists are equal. The ratchet still bites — adding an eighth routable type
    // without an adapter fails BOTH assertions below.
    expect([...PEEKABLE_WITH_BODY].sort()).toEqual([
      "ask",
      "changeset",
      "conversation",
      "interceptor",
      "memory",
      "session",
      "task",
    ]);
    expect(ROUTABLE_ENTITY_TYPES).toHaveLength(7);
  });

  test("every routable type has a body — the open-as-page placeholder is gone (mt#4069)", () => {
    // The complement of the ratchet above, stated as the property the task
    // actually delivers: no routable type falls through to a placeholder.
    for (const type of ROUTABLE_ENTITY_TYPES) {
      expect(PEEKABLE_WITH_BODY).toContain(type);
    }
  });
});

describe("AT7 — an outside click dismisses the assembly, not one pane (mt#4143)", () => {
  // Radix registers its document-level outside listener in a deferred task, so a
  // pointerdown fired in the same tick as the render reaches nothing. Without
  // this wait every test below passes vacuously — the panes survive because no
  // handler ran at all, which is indistinguishable from the exemption working.
  const settleOutsideListener = () => new Promise((r) => setTimeout(r, 20));

  async function openHeldPair() {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");
    fireEvent.click(memoryRef(), { button: 0, shiftKey: true });
    await waitFor(() => expect(screen.getAllByTestId("peek-pane")).toHaveLength(2));
    await settleOutsideListener();
  }

  test("clicking inside a SIBLING pane closes nothing — the held-pair case", async () => {
    await openHeldPair();
    const [paneA, paneB] = screen.getAllByTestId("peek-pane");

    // Click the FIRST pane, not the last, and the distinction is load-bearing.
    // Dismissal is owned by the LAST pane alone, so a click on the last pane is
    // "inside" the only pane that could act on it and the pane exemption is
    // never consulted — a version of this test that clicked pane B passed with
    // the exemption deleted. Clicking pane A is what puts the last pane's
    // handler in front of a target inside a DIFFERENT pane, which is the case
    // the exemption exists for.
    fireEvent.pointerDown(paneA!);

    await settleOutsideListener();
    expect(screen.getAllByTestId("peek-pane")).toHaveLength(2);
    expect(paneB!.isConnected).toBe(true);
    expect(screen.getByTestId("location").textContent).toContain("peek=");
  });

  test("clicking a sibling pane's CLOSE BUTTON closes only that pane", async () => {
    await openHeldPair();
    const closeMemory = screen.getByLabelText("Close fbcb360f-fe0e-402d-9b35-7e3c2b2ab59a");

    fireEvent.pointerDown(closeMemory);
    fireEvent.click(closeMemory);

    await waitFor(() => expect(screen.getAllByTestId("peek-pane")).toHaveLength(1));
    expect(screen.getAllByTestId("peek-pane")[0]?.getAttribute("data-peek-type")).toBe("task");
  });

  test("clicking neutral page chrome dismisses BOTH panes and clears the URL", async () => {
    await openHeldPair();

    fireEvent.pointerDown(screen.getByText("Underlying page"));

    await waitFor(() => expect(screen.queryByTestId("peek-pane")).toBeNull());
    expect(screen.getByTestId("location").textContent).toBe("/tasks/mt%232370");
  });

  test("clicking neutral page chrome dismisses a single pane too", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");
    await settleOutsideListener();

    fireEvent.pointerDown(screen.getByText("Underlying page"));

    await waitFor(() => expect(screen.queryByTestId("peek-pane")).toBeNull());
    expect(screen.getByTestId("location").textContent).toBe("/tasks/mt%232370");
  });

  test("an outside dismissal returns focus to the opener, like Esc and the close button", async () => {
    renderShell();
    const opener = taskRef();
    fireEvent.click(opener, { button: 0 });
    await screen.findByTestId("peek-pane");
    await settleOutsideListener();

    fireEvent.pointerDown(screen.getByText("Underlying page"));

    await waitFor(() => expect(screen.queryByTestId("peek-pane")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  test("clicking an entity ref REPLACES rather than dismissing", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");
    await settleOutsideListener();

    // The ref is outside the pane, so without its exemption this click would
    // dismiss the assembly on its way to opening the next entity.
    fireEvent.pointerDown(memoryRef());
    fireEvent.click(memoryRef(), { button: 0 });

    await waitFor(() => {
      const panes = screen.getAllByTestId("peek-pane");
      expect(panes).toHaveLength(1);
      expect(panes[0]?.getAttribute("data-peek-type")).toBe("memory");
    });
  });

  test("shift-clicking an entity ref still HOLDS rather than dismissing", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");
    await settleOutsideListener();

    fireEvent.pointerDown(memoryRef(), { shiftKey: true });
    fireEvent.click(memoryRef(), { button: 0, shiftKey: true });

    await waitFor(() => expect(screen.getAllByTestId("peek-pane")).toHaveLength(2));
  });

  test("focus leaving the pane does NOT dismiss — only a click does", async () => {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");
    await settleOutsideListener();

    // ask#8509 decided what a CLICK does. Tabbing to the page behind is not a
    // dismissal gesture; treating it as one makes the peek keyboard-hostile.
    fireEvent.focusIn(screen.getByText("Underlying page"));

    await settleOutsideListener();
    expect(screen.getAllByTestId("peek-pane")).toHaveLength(1);
  });

  test("Esc still unwinds ONE pane at a time, not the whole assembly", async () => {
    await openHeldPair();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.getAllByTestId("peek-pane")).toHaveLength(1));
    expect(screen.getAllByTestId("peek-pane")[0]?.getAttribute("data-peek-type")).toBe("task");
  });
});

describe("the peek's width is the operator's (mt#4261)", () => {
  // Same deferred-listener wait as AT7, and load-bearing for the same reason:
  // the whole point of the first test below is that a handler DID run and chose
  // not to dismiss, which is indistinguishable from no handler running at all.
  const settleOutsideListener = () => new Promise((r) => setTimeout(r, 20));

  async function openOnePane() {
    renderShell();
    fireEvent.click(taskRef(), { button: 0 });
    await screen.findByTestId("peek-pane");
    await settleOutsideListener();
  }

  /**
   * The width every pane actually renders at.
   *
   * Read from the host's `--peek-pane-width` rather than `pane.style.width`
   * because mt#4274 moved the number there: the pane's own rule is
   * `width: var(--peek-pane-width, …)`, so a drag can repaint by writing one
   * property instead of re-rendering every pane body. `pane.style.width` now
   * holds the `var()` expression, and happy-dom does not resolve it — reading it
   * would assert on the indirection rather than on the width.
   */
  function renderedWidthPx(): number {
    const host = screen.getByTestId("peek-host");
    return Number.parseInt(host.style.getPropertyValue("--peek-pane-width"), 10);
  }

  test("renders one divider for the assembly, naming every pane it sizes", async () => {
    await openOnePane();
    const divider = screen.getByTestId("peek-divider");
    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.getAttribute("aria-controls")).toBe("peek-pane-0");

    // Hold, open a second: still ONE divider, now naming both panes, because the
    // width is shared rather than per-pane.
    fireEvent.click(memoryRef(), { button: 0, shiftKey: true });
    await waitFor(() => expect(screen.getAllByTestId("peek-pane")).toHaveLength(2));
    expect(screen.getAllByTestId("peek-divider")).toHaveLength(1);
    expect(screen.getByTestId("peek-divider").getAttribute("aria-controls")).toBe(
      "peek-pane-0 peek-pane-1"
    );
    // Both ids resolve — an `aria-controls` pointing at nothing is worse than none.
    expect(document.getElementById("peek-pane-0")).not.toBeNull();
    expect(document.getElementById("peek-pane-1")).not.toBeNull();
  });

  test("dragging the divider does NOT dismiss the assembly", async () => {
    // The regression this exists for: the divider is a flex sibling of the
    // panes, so every pane's Radix layer reports a pointerdown on it as OUTSIDE.
    // Without the assembly exemption the first event of every drag closes the
    // peek under the operator's cursor.
    await openOnePane();

    fireEvent.pointerDown(screen.getByTestId("peek-divider"), { clientX: 700, button: 0 });
    await settleOutsideListener();

    expect(screen.getAllByTestId("peek-pane")).toHaveLength(1);
    expect(screen.getByTestId("location").textContent).toContain("peek=");
  });

  test("resizing leaves the URL completely untouched", async () => {
    // The width is a PREFERENCE, not part of the peek's address: a copied peek
    // link must carry which entities are open and never the copier's window
    // size. Asserted as string equality rather than "still contains peek=",
    // which would pass even if the width had been appended as a parameter.
    await openOnePane();
    const urlBefore = screen.getByTestId("location").textContent;

    fireEvent.pointerDown(screen.getByTestId("peek-divider"), { clientX: 700, button: 0 });
    fireEvent.pointerMove(window, { clientX: 600 });
    fireEvent.pointerUp(window, { clientX: 600 });
    await waitFor(() => expect(localStorage.getItem("cockpit.peek.width.v1")).not.toBeNull());

    expect(screen.getByTestId("location").textContent).toBe(urlBefore);
  });

  test("a drag widens the pane and persists the width", async () => {
    await openOnePane();
    const before = renderedWidthPx();

    // Right-anchored: dragging the pointer LEFT widens.
    fireEvent.pointerDown(screen.getByTestId("peek-divider"), { clientX: 700, button: 0 });
    fireEvent.pointerMove(window, { clientX: 600 });
    fireEvent.pointerUp(window, { clientX: 600 });

    await waitFor(() => expect(renderedWidthPx()).not.toBe(before));
    expect(renderedWidthPx()).toBe(before + 100);
    expect(localStorage.getItem("cockpit.peek.width.v1")).toBe(String(before + 100));
  });

  test("the pane repaints DURING the drag, before the pointer is released (mt#4274)", async () => {
    // The property this task exists for: the width tracks the pointer while the
    // button is still down. Before mt#4274 that was true only because every move
    // pushed React state through the whole assembly; now the move repaints and
    // only the release commits, so this asserts the repaint half in isolation.
    await openOnePane();
    const before = renderedWidthPx();

    fireEvent.pointerDown(screen.getByTestId("peek-divider"), { clientX: 700, button: 0 });
    fireEvent.pointerMove(window, { clientX: 640 });

    expect(renderedWidthPx()).toBe(before + 60);
    // ...and nothing has been recorded yet, because the drag is not over.
    expect(localStorage.getItem("cockpit.peek.width.v1")).toBeNull();

    fireEvent.pointerUp(window, { clientX: 640 });
    await waitFor(() =>
      expect(localStorage.getItem("cockpit.peek.width.v1")).toBe(String(before + 60))
    );
  });

  test("the divider announces the live width mid-drag, not the pre-drag one (mt#4274)", async () => {
    // The host deliberately does not re-render until release, so `aria-valuenow`
    // would freeze at the starting width if the divider did not track it itself.
    await openOnePane();
    const divider = screen.getByTestId("peek-divider");
    const before = Number(divider.getAttribute("aria-valuenow"));

    fireEvent.pointerDown(divider, { clientX: 700, button: 0 });
    fireEvent.pointerMove(window, { clientX: 620 });

    expect(Number(divider.getAttribute("aria-valuenow"))).toBe(before + 80);

    fireEvent.pointerUp(window, { clientX: 620 });
    await waitFor(() =>
      expect(Number(divider.getAttribute("aria-valuenow"))).toBe(before + 80)
    );
  });

  test("Home CLEARS the preference rather than storing the current default", async () => {
    await openOnePane();

    fireEvent.pointerDown(screen.getByTestId("peek-divider"), { clientX: 700, button: 0 });
    fireEvent.pointerMove(window, { clientX: 600 });
    fireEvent.pointerUp(window, { clientX: 600 });
    await waitFor(() => expect(localStorage.getItem("cockpit.peek.width.v1")).not.toBeNull());

    fireEvent.keyDown(screen.getByTestId("peek-divider"), { key: "Home" });

    // Storing today's default instead would freeze a viewport-derived number
    // into a preference the operator never expressed, and the pane would stop
    // responding to window size from the moment they pressed Home.
    await waitFor(() => expect(localStorage.getItem("cockpit.peek.width.v1")).toBeNull());
  });

  test("a stored preference is restored on the next open", async () => {
    localStorage.setItem("cockpit.peek.width.v1", "512");
    await openOnePane();
    expect(renderedWidthPx()).toBe(512);
  });

  test("a stored value outside the bounds falls back to the default, not to the nearest edge", async () => {
    // `pane-width.ts` treats out-of-range as ABSENT on purpose: the bounds
    // moving means the operator never chose that width under this layout.
    localStorage.setItem("cockpit.peek.width.v1", "9000");
    await openOnePane();
    expect(renderedWidthPx()).toBe(416);
  });
});
