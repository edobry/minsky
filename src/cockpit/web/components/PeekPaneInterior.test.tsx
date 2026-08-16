/**
 * Peek pane interior composition (mt#4123).
 *
 * ## What this file can and cannot assert
 *
 * These are CLASS-SHAPE assertions, and that is a deliberate ceiling, not an
 * oversight. The component suite runs under happy-dom, which has no layout
 * engine: `clientHeight`, `scrollHeight` and `getBoundingClientRect()` all read
 * 0 (measured mt#3338), so "the pane has a 16px gutter" and "there is exactly
 * one scrollport" cannot be stated here at all. `scripts/verify-peek-pane-layout.ts`
 * asserts those against a real browser over CDP, and the split follows
 * `src/cockpit/CLAUDE.md` §"Asserting layout geometry".
 *
 * What IS worth pinning here is the COMPOSITION — which variant each body is
 * given, and whether the page-only chrome is present — because that is the layer
 * the defect actually lived in. mt#3694's peek shipped with 12 integration tests
 * and a live browser check and still looked wrong, because every one of them
 * asked a question a badly-composed pane answers correctly. These ask the
 * question that was missing: is the body being handed the pane's context, or the
 * page's?
 *
 * Run via `bun run test:components`.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TaskDetail } from "../widgets/TaskDetail";
import { SheetBody, SheetHeader } from "./ui/sheet";
import { WidgetShell } from "./WidgetShell";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const SPEC_TEXT = "Summary paragraph that stands in for a long task spec.";

function stubTaskDetail(): void {
  globalThis.fetch = mock(async () =>
    new Response(
      JSON.stringify({
        task: {
          id: "mt#4123",
          title: "Peek pane interior",
          status: "IN-PROGRESS",
          kind: "implementation",
          tags: [],
        },
        spec: `## Summary\n\n${SPEC_TEXT}\n`,
        parent: null,
        children: [],
        deps: { outgoing: [], incoming: [] },
        actions: [],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  ) as unknown as typeof globalThis.fetch;
}

function renderTaskDetail(variant: "page-body" | "peek") {
  stubTaskDetail();
  return render(
    <MemoryRouter>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <TaskDetail taskId="mt#4123" variant={variant} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

/** The spec body's rendered root — the element that carried the page-only chrome. */
async function specRoot(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getByText(SPEC_TEXT)).toBeTruthy());
  const el = screen.getByText(SPEC_TEXT).closest(".break-words");
  expect(el).toBeTruthy();
  return el as HTMLElement;
}

describe("SheetBody / SheetHeader gutters (mt#4123)", () => {
  test("SheetBody carries horizontal padding, so no body has to supply its own", () => {
    // The reported defect in its smallest form: before mt#4123 this element's
    // entire class list was `min-h-0 flex-1 overflow-auto`, so every one of the
    // seven peek bodies rendered flush against the pane's border.
    const { container } = render(<SheetBody data-testid="body">content</SheetBody>);
    const cls = (container.querySelector('[data-testid="body"]') as HTMLElement).className;
    expect(cls).toContain("px-4");
    expect(cls).toContain("py-3");
  });

  test("SheetHeader's horizontal gutter matches SheetBody's", () => {
    // Not a style preference — an unequal pair puts a visible step in the pane's
    // left edge. This was a real intermediate state of mt#4123's own fix: the
    // body moved to 16px while the header stayed at 12px, measured in a browser
    // as content starting at 17px and 13px from the pane border.
    //
    // Asserted as EQUALITY of the two horizontal classes rather than as the
    // literal `px-4`, so a future redesign that moves both together passes and
    // one that moves only one fails.
    const { container: headerC } = render(<SheetHeader data-testid="h">h</SheetHeader>);
    const { container: bodyC } = render(<SheetBody data-testid="b">b</SheetBody>);
    const horizontal = (el: Element) =>
      String((el as HTMLElement).className)
        .split(/\s+/)
        .filter((c) => /^px-/.test(c));

    expect(horizontal(headerC.querySelector('[data-testid="h"]')!)).toEqual(
      horizontal(bodyC.querySelector('[data-testid="b"]')!)
    );
  });
});

describe("WidgetShell peek variant (mt#4123)", () => {
  test("renders a labelled section and supplies no padding of its own", () => {
    // Padding belongs to `SheetBody`, which wraps every peek body. A shell that
    // also padded would double it for the bodies that route through one.
    const { container } = render(
      <WidgetShell variant="peek" title="Peeked entity">
        <p>body</p>
      </WidgetShell>
    );
    const section = container.querySelector("section") as HTMLElement;
    expect(section).toBeTruthy();
    expect(section.getAttribute("aria-label")).toBe("Peeked entity");
    expect(section.className).not.toMatch(/(^|\s)p[xytblr]?-\d/);
  });
});

describe("TaskDetail render context (mt#4123)", () => {
  test("in a peek, the spec drops its cap, its own scroller and its card frame", async () => {
    // The worst of the five reported defects, and the one no amount of pane-side
    // CSS could reach: page-only chrome INSIDE the body. In a browser this was a
    // 10,845px document rendered into a 540px inner window with its own
    // scrollbar, sitting inside the pane's scrollbar.
    renderTaskDetail("peek");
    const root = await specRoot();

    expect(root.className).not.toContain("max-h-");
    expect(root.className).not.toContain("overflow-auto");
    expect(root.className).not.toContain("bg-muted/20");
    expect(root.className).not.toContain("rounded");
  });

  test("on a page, the spec keeps all of it — the peek fix does not leak", async () => {
    // The control, and the half that makes the test above mean anything: a
    // change that simply deleted the cap everywhere would pass that assertion
    // while silently altering the task page. The cap is correct THERE — a route
    // showing a long spec beside other sections caps it so the page stays
    // navigable.
    renderTaskDetail("page-body");
    const root = await specRoot();

    expect(root.className).toContain("max-h-[60vh]");
    expect(root.className).toContain("overflow-auto");
    expect(root.className).toContain("bg-muted/20");
  });
});
