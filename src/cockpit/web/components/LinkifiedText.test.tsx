/**
 * LinkifiedText — the single-line path carries the SAME affordances as prose
 * (mt#4630).
 *
 * The bug these pin: an entity reference inside an ask's OPTION LABEL rendered
 * a bare `<Link>` — linked, but with no hover card and no click-to-peek — while
 * the identical reference in the ask's QUESTION, one line above and rendered by
 * `<Prose>`, carried both. mt#3165's adoption pass (mt#3175) converted the
 * prose paths to `<EntityRef>` and left this sibling on `linkifyText`'s bare
 * `<Link>` output.
 *
 * Modelled on `Prose.peek.test.tsx`, deliberately: click behaviour is asserted
 * through the URL, where the peek's state actually lives (`?peek=`, mt#3694),
 * not through a spy on `openPeek` — a spy passes just as happily when the pane
 * never opens.
 *
 * The density tests are the other half and matter as much as the affordance
 * ones. mt#3165 admits this path precisely BECAUSE these rows are truncated
 * single lines ("density is a feature"), so a fix that bought the hover card by
 * growing the row would have traded one defect for the regression mt#2556
 * introduced and mt#3175 was careful not to repeat.
 */
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LinkifiedText } from "./LinkifiedText";
import { buildEntityIndex } from "../lib/entity-linkifier";
import { ENTITY_REF_ATTR } from "../lib/peek-dismiss";

const TASK_ID = "mt#2370";
const TASK_TITLE = "Cockpit shell: rail + tabs";
const TASK_PATH = "/tasks/mt%232370";

/** The page the reader is standing on — the asks list, as in the report. */
const ORIGIN = "/asks";

const originalFetch = global.fetch;

/** No label resolves; the reference must still render its matched text. */
function silentLabelChannel() {
  global.fetch = mock(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
}

/** The label channel answers, so the appendLabel/aria-label split is testable. */
function resolvingLabelChannel() {
  global.fetch = mock(async (url: string) => {
    if (String(url).startsWith("/api/tasks/meta")) {
      return {
        ok: true,
        json: async () => ({ tasks: [{ id: TASK_ID, title: TASK_TITLE, status: "READY" }] }),
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(silentLabelChannel);

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
    taskIds: [TASK_ID],
    sessionIds: [],
    askIds: [],
    memoryIds: [],
  });
}

/** Renders the way a real call site does: inline, inside a single-line row. */
function renderInline(text: string, index = makeIndex()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[ORIGIN]}>
        <Routes>
          <Route
            path="*"
            element={
              <div>
                <span className="truncate" data-testid="row">
                  {"B. "}
                  <LinkifiedText text={text} index={index} />
                </span>
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

describe("LinkifiedText — the affordances prose already had (mt#4630)", () => {
  test("AT1: the anchor is an EntityRef, not a bare Link", () => {
    renderInline(`adopt the approach in ${TASK_ID}`);
    const link = theLink();
    // The two attributes that WERE absent on this path and present on the
    // prose one: the peek wiring/outside-dismiss exemption (mt#4143) and the
    // Radix hover-card trigger's state. This is the exact discriminator the
    // mt#4630 reproduction probe compared the two paths on.
    expect(link.hasAttribute(ENTITY_REF_ATTR)).toBe(true);
    expect(link.hasAttribute("data-state")).toBe(true);
  });

  test("AT2: an ordinary click opens the peek instead of navigating away", () => {
    renderInline(`adopt the approach in ${TASK_ID}`);
    fireEvent.click(theLink(), { button: 0 });
    expect(location()).toContain("peek=task%3A");
    expect(location().startsWith(ORIGIN)).toBe(true);
  });

  test("AT3: the href survives, so Cmd-click still promotes to the full page", () => {
    renderInline(`adopt the approach in ${TASK_ID}`);
    const link = theLink();
    expect(link.getAttribute("href")).toBe(TASK_PATH);
    fireEvent.click(link, { button: 0, metaKey: true });
    expect(location()).not.toContain("peek=");
  });

  test("AT3: middle-click does not peek either", () => {
    renderInline(`adopt the approach in ${TASK_ID}`);
    fireEvent.click(theLink(), { button: 1 });
    expect(location()).not.toContain("peek=");
  });

  test("AT4: an id absent from the index stays plain text (zero false positives)", () => {
    const emptyIndex = buildEntityIndex({
      taskIds: [],
      sessionIds: [],
      askIds: [],
      memoryIds: [],
    });
    const { container } = renderInline(`adopt the approach in ${TASK_ID}`, emptyIndex);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(screen.getByTestId("row").textContent).toBe(`B. adopt the approach in ${TASK_ID}`);
  });
});

describe("LinkifiedText — density is preserved (mt#3165's Shape-2 constraint)", () => {
  test("no block-level wrapper is introduced", () => {
    const { container } = renderInline(`adopt the approach in ${TASK_ID}`);
    // The reason this path exists at all instead of <Prose> (mt#2556).
    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector("ul")).toBeNull();
    expect(container.querySelector("div.prose")).toBeNull();
  });

  test("a RESOLVED title is not appended inline — it reaches the row via aria-label", async () => {
    resolvingLabelChannel();
    renderInline(`adopt the approach in ${TASK_ID}`);

    // Wait for the label to actually arrive, so this is a real assertion about
    // the resolved state rather than one that passes because nothing resolved.
    await waitFor(() => expect(theLink().getAttribute("aria-label")).toContain(TASK_TITLE));

    // appendLabel is NOT set here: the visible row is the matched substring and
    // nothing more, so the line cannot grow. The title is still reachable by
    // keyboard and screen reader (mt#3187) — hover is additive, never the only
    // path to an identity (mt#3165 §"Hover is supplementary").
    expect(theLink().textContent).toBe(TASK_ID);
    expect(screen.getByTestId("row").textContent).toBe(`B. adopt the approach in ${TASK_ID}`);
  });

  test("the monospace face is still per-token, as it was before mt#4630", () => {
    renderInline(`adopt the approach in ${TASK_ID}`);
    // A task id is an identifier and renders mono; this is the class
    // `linkifyText` applied via LINK_CLASS_MONO, preserved exactly.
    expect(theLink().className).toContain("font-mono");
  });

  test("a minsky:// reference keeps its NON-mono face", () => {
    renderInline(`adopt the approach in minsky://task/mt%232370`);
    // `mono: false` on the token — the class linkifyText applied via LINK_CLASS.
    // Passing token.mono through to EntityRef (whose own default is mono) is
    // what preserves this; dropping it would silently re-typeset these.
    expect(theLink().className).not.toContain("font-mono");
  });
});
