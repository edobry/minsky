/**
 * Tests for JsonView (mt#2552) — recursive tree (Tier 1) + entity-enriched
 * leaves (Tier 2). Rendered with @testing-library/react under happy-dom.
 *
 * mt#3175: Tier-2 leaf links now route through the shared <EntityRef> (adds
 * the hover-card badge treatment) instead of a bare react-router <Link>, so
 * every render needs a QueryClientProvider (EntityRef resolves its label via
 * useResolvedEntityLabel -> useQuery/useQueries) — `global.fetch` is stubbed
 * to degrade safely (no real network), matching EntityRef.test.tsx's pattern.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JsonView } from "./JsonView";
import { buildEntityIndex } from "../lib/entity-linkifier";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

const TASK_ID = "mt#2370";
const TASK_PATH = "/tasks/mt%232370";

function makeIndex() {
  return buildEntityIndex({ taskIds: [TASK_ID], sessionIds: [], askIds: [], memoryIds: [] });
}

function stubFetchDegraded(): void {
  global.fetch = mock(async () =>
    Promise.resolve({ ok: false, json: async () => ({}) } as Response)
  ) as unknown as typeof fetch;
}

function renderTree(ui: React.ReactElement) {
  stubFetchDegraded();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

/** Click the first element of a query-result array (throws if empty, instead of `[0]!`). */
function clickFirst(elements: HTMLElement[]): void {
  const el = elements[0];
  if (!el) {
    throw new Error("clickFirst: expected at least one matching element");
  }
  fireEvent.click(el);
}

describe("JsonView — Tier 1 (structure)", () => {
  test("renders object keys and primitive values", () => {
    const { container } = renderTree(<JsonView data={{ name: "alpha", count: 3, ok: true }} />);
    expect(container.textContent).toContain("name");
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("3");
    expect(container.textContent).toContain("true");
  });

  test("renders nested arrays", () => {
    const { container } = renderTree(<JsonView data={{ items: ["a", "b"] }} />);
    expect(container.textContent).toContain("items");
    expect(container.textContent).toContain("a");
    expect(container.textContent).toContain("b");
  });

  test("empty object renders braces", () => {
    const { container } = renderTree(<JsonView data={{}} />);
    expect(container.textContent).toContain("{}");
  });

  test("collapse toggle hides nested children", () => {
    const { container, getAllByRole } = renderTree(<JsonView data={{ a: { b: "deep" } }} />);
    expect(container.textContent).toContain("deep");
    clickFirst(getAllByRole("button")); // collapse the root node
    expect(container.textContent).not.toContain("deep");
  });
});

describe("JsonView — collapsed-node key previews (mt#2793)", () => {
  test("collapsed object shows up to 4 key names + ellipsis", () => {
    const { container, getAllByRole } = renderTree(
      <JsonView data={{ a: 1, b: 2, c: 3, d: 4, e: 5 }} />
    );
    clickFirst(getAllByRole("button")); // collapse the root node
    expect(container.textContent).toContain("a, b, c, d, …");
    // The 5th key is elided, not just truncated silently.
    expect(container.textContent).not.toContain("a, b, c, d, e");
  });

  test("collapsed object with <=4 keys shows all keys, no ellipsis", () => {
    const { container, getAllByRole } = renderTree(<JsonView data={{ a: 1, b: 2 }} />);
    clickFirst(getAllByRole("button"));
    expect(container.textContent).toContain("a, b");
    expect(container.textContent).not.toContain("…");
  });

  test("collapsed array shows length and element kind (primitives)", () => {
    const { container, getAllByRole } = renderTree(<JsonView data={[1, 2, 3]} />);
    clickFirst(getAllByRole("button"));
    expect(container.textContent).toContain("3 × number");
  });

  test("collapsed array of objects shows the {…} element kind", () => {
    const { container, getAllByRole } = renderTree(
      <JsonView data={[{ x: 1 }, { y: 2 }, { z: 3 }]} />
    );
    clickFirst(getAllByRole("button"));
    expect(container.textContent).toContain("3 × {…}");
  });

  test("collapsed array with heterogeneous elements shows 'mixed'", () => {
    const { container, getAllByRole } = renderTree(<JsonView data={[1, "two", { x: 3 }]} />);
    clickFirst(getAllByRole("button"));
    expect(container.textContent).toContain("3 × mixed");
  });

  test("expanded nodes are unaffected — full keys and values still render", () => {
    // Root is at depth 0 (< 2), so it starts open by default: no collapse
    // needed to observe unchanged expanded behavior.
    const { container } = renderTree(<JsonView data={{ a: 1, b: 2, c: 3, d: 4, e: 5 }} />);
    expect(container.textContent).toContain("a");
    expect(container.textContent).toContain("e");
    expect(container.textContent).toContain("5");
  });
});

describe("JsonView — Tier 2 (entity-enriched leaves)", () => {
  test("a known entity ref in a string value becomes an in-SPA link", () => {
    const { container } = renderTree(
      <JsonView data={{ task: TASK_ID }} entityIndex={makeIndex()} />
    );
    const a = container.querySelector(`a[href="${TASK_PATH}"]`);
    expect(a).not.toBeNull();
    expect(a?.textContent).toBe(TASK_ID);
  });

  test("mt#3175: a resolved entity ref routes through <EntityRef> — hover-card trigger present, visible text unchanged", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ tasks: [{ id: TASK_ID, title: "Fix the widget", status: "READY" }] }),
        } as Response);
      }
      return Promise.resolve({ ok: false, json: async () => ({}) } as Response);
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <JsonView data={{ task: TASK_ID }} entityIndex={makeIndex()} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const a = container.querySelector(`a[href="${TASK_PATH}"]`);
    expect(a).not.toBeNull();
    // <EntityRef>'s children mode preserves the exact matched text — the
    // label resolves for the hover card only, never inline (mt#3165 "Hover
    // is supplementary").
    expect(a?.textContent).toBe(TASK_ID);
    // The Radix HoverCardTrigger wraps the anchor with `asChild` — data-state
    // is the cheapest signal the hover-card primitive (not a bare Link) is
    // in the tree, without asserting on portalled content.
    expect(a?.getAttribute("data-state")).not.toBeNull();
  });

  test("a URL string value becomes an external link", () => {
    const { container } = renderTree(<JsonView data={{ url: "https://example.com/x" }} />);
    const a = container.querySelector('a[href="https://example.com/x"]');
    expect(a).not.toBeNull();
    expect(a?.getAttribute("target")).toBe("_blank");
  });

  test("without an entityIndex, refs are plain text (no link)", () => {
    const { container } = renderTree(<JsonView data={{ task: TASK_ID }} />);
    expect(container.querySelector(`a[href="${TASK_PATH}"]`)).toBeNull();
    expect(container.textContent).toContain(TASK_ID);
  });
});

describe("JsonView — multiline string leaves (mt#2788)", () => {
  test("a multiline string renders as a preformatted block with newlines preserved", () => {
    const { container } = renderTree(<JsonView data={{ output: "a\nb\nc" }} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe("a\nb\nc");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect(pre?.className).toContain("max-h-48"); // bounded so one output can't dominate
  });

  test("CRLF and bare-CR strings also take the block presentation", () => {
    const crlf = renderTree(<JsonView data={{ output: "a\r\nb" }} />);
    expect(crlf.container.querySelector("pre")).not.toBeNull();
    cleanup();
    const cr = renderTree(<JsonView data={{ output: "a\rb" }} />);
    expect(cr.container.querySelector("pre")).not.toBeNull();
  });

  test("a single-line string stays an inline quoted leaf (no pre)", () => {
    const { container } = renderTree(<JsonView data={{ s: "one line" }} />);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toContain('"one line"');
  });

  test("entity refs inside a multiline leaf are still linkified", () => {
    const { container } = renderTree(
      <JsonView data={{ output: `line1\nsee ${TASK_ID}\nline3` }} entityIndex={makeIndex()} />
    );
    const a = container.querySelector(`a[href="${TASK_PATH}"]`);
    expect(a).not.toBeNull();
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("line1\nsee ");
    expect(pre?.textContent).toContain("\nline3");
  });
});
