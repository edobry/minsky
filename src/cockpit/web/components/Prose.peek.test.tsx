/**
 * Prose — an AUTHORED entity link peeks, exactly like a linkified one (mt#4351).
 *
 * The bug these pin: `<Prose>`'s `a` override branched on the href's SPELLING.
 * A bare `mem#728` became a linkifier anchor carrying `data-entity-*` and
 * rendered through `<EntityRef>`, so a click opened the peek; the same
 * reference written as `[mem#728](minsky://memory/<uuid>)` — the form
 * `cockpit-deeplinks.mdc` tells agents to emit, and therefore the form every
 * stored conversation is full of — took the `minsky://` branch, rendered a
 * plain `<Link>`, and navigated the page away.
 *
 * So the FIRST test here is the control: it asserts the already-working
 * linkified path still peeks. Without it, a regression that broke both paths
 * would leave the authored-link tests failing for a reason they do not name.
 *
 * Click behaviour is asserted through the URL, which is where the peek's state
 * actually lives (`?peek=`, mt#3694) — not through a spy on `openPeek`, which
 * would pass just as happily if the pane never opened.
 */
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Prose } from "./Prose";
import { buildEntityIndex } from "../lib/entity-linkifier";
import { ENTITY_REF_ATTR } from "../lib/peek-dismiss";

const MEMORY_UUID = "fbcb360f-fe0e-402d-9b35-7e3c2b2ab59a";
const MEMORY_SHORT_ID = "mem#728";
const MEMORY_PATH = `/memory/${MEMORY_UUID}`;
const EXPECTED_PEEK = `?peek=memory%3A${MEMORY_UUID}`;

/** The page the reader is standing on — a conversation, as in the report. */
const ORIGIN = "/conversation/abc";

const originalFetch = global.fetch;

beforeEach(() => {
  // Label lookups degrade safely; these tests are about the click, not the
  // hover card's contents.
  global.fetch = mock(async () => ({
    ok: true,
    json: async () => ({}),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

/** Surfaces the live location so the URL contract can be asserted directly. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function makeIndex() {
  return buildEntityIndex({
    taskIds: [],
    sessionIds: [],
    askIds: [],
    memoryIds: [MEMORY_UUID],
    memoryShortIds: [{ shortId: MEMORY_SHORT_ID, id: MEMORY_UUID }],
  });
}

function renderProse(markdown: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[ORIGIN]}>
        <Routes>
          <Route
            path="*"
            element={
              <div>
                <Prose entityIndex={makeIndex()}>{markdown}</Prose>
                <LocationProbe />
              </div>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function theLink(): HTMLElement {
  const links = screen.getAllByRole("link");
  expect(links).toHaveLength(1);
  return links[0]!;
}

function location(): string {
  return screen.getByTestId("location").textContent ?? "";
}

describe("Prose — authored entity links open the peek (mt#4351)", () => {
  test("control: a LINKIFIED bare ref peeks (the path that already worked)", () => {
    renderProse(`see ${MEMORY_SHORT_ID} for the detail`);
    fireEvent.click(theLink(), { button: 0 });
    expect(location()).toBe(`${ORIGIN}${EXPECTED_PEEK}`);
  });

  test("AT1: a minsky:// markdown deeplink peeks instead of navigating", () => {
    renderProse(`see [${MEMORY_SHORT_ID}](minsky://memory/${MEMORY_UUID}) for the detail`);
    const link = theLink();
    // The href is unchanged — Cmd-click and "open in new tab" still promote to
    // the full page, which only works on a real anchor with a real href.
    expect(link.getAttribute("href")).toBe(MEMORY_PATH);
    fireEvent.click(link, { button: 0 });
    expect(location()).toBe(`${ORIGIN}${EXPECTED_PEEK}`);
  });

  test("AT2: an authored internal PATH link peeks too", () => {
    renderProse(`see [the note](${MEMORY_PATH}) for the detail`);
    fireEvent.click(theLink(), { button: 0 });
    expect(location()).toBe(`${ORIGIN}${EXPECTED_PEEK}`);
  });

  test("AT3: an internal path naming no entity still navigates", () => {
    renderProse("see [activity](/activity) for the detail");
    const link = theLink();
    expect(link.getAttribute("href")).toBe("/activity");
    fireEvent.click(link, { button: 0 });
    expect(location()).toBe("/activity");
  });

  test("AT4: Cmd-click on an authored deeplink does NOT peek", () => {
    renderProse(`see [${MEMORY_SHORT_ID}](minsky://memory/${MEMORY_UUID}) for the detail`);
    fireEvent.click(theLink(), { button: 0, metaKey: true });
    expect(location()).not.toContain("peek=");
  });

  test("AT4: middle-click does NOT peek either", () => {
    renderProse(`see [${MEMORY_SHORT_ID}](minsky://memory/${MEMORY_UUID}) for the detail`);
    fireEvent.click(theLink(), { button: 1 });
    expect(location()).not.toContain("peek=");
  });

  test("AT4: shift-click HOLDS, so the next click lands beside it", () => {
    // The gestures come from `classifyRefClick`, which authored links now reach
    // for the first time — so "inherited" is asserted, not assumed.
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[ORIGIN]}>
          <Routes>
            <Route
              path="*"
              element={
                <div>
                  <Prose entityIndex={makeIndex()}>
                    {`[${MEMORY_SHORT_ID}](minsky://memory/${MEMORY_UUID}) and ` +
                      "[mt#4351](minsky://task/mt%234351)"}
                  </Prose>
                  <LocationProbe />
                </div>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const [memoryLink, taskLink] = screen.getAllByRole("link");
    // Order matters, and getting it wrong is how this test first failed:
    // shift-click holds the pane that is ALREADY open, so the ordinary click
    // comes first. Shift-clicking into an empty peek has nothing to hold.
    fireEvent.click(memoryLink!, { button: 0 });
    fireEvent.click(taskLink!, { button: 0, shiftKey: true });
    // Both panes present: the second landed BESIDE the held first rather than
    // replacing it.
    const search = location();
    expect(search).toContain(`memory%3A${MEMORY_UUID}`);
    expect(search).toContain("task%3Amt%25234351");
  });

  test("AT5: the author's own label is rendered verbatim — no appended title", () => {
    renderProse(`see [${MEMORY_SHORT_ID}](minsky://memory/${MEMORY_UUID}) for the detail`);
    // `appendLabel` is deliberately off on this path: the author chose the
    // label, unlike a bare ref whose matched text is a raw id.
    expect(theLink().textContent).toBe(MEMORY_SHORT_ID);
  });

  test("AT6: an unparseable minsky:// URI still degrades to a non-link span", () => {
    renderProse("see [thing](minsky://bogus/xyz) for the detail");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText("thing").tagName).toBe("SPAN");
  });

  test("AT7: the anchor carries the outside-dismiss exemption attribute", () => {
    renderProse(`see [${MEMORY_SHORT_ID}](minsky://memory/${MEMORY_UUID}) for the detail`);
    // Without it (mt#4143) the same click that opens the assembly would also
    // be read as an outside click dismissing it.
    expect(theLink().getAttribute(ENTITY_REF_ATTR)).toBe("true");
  });
});
