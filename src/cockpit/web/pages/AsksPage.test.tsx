/**
 * AsksPage GroupSubjectBadge entity-reference adoption test (mt#3187).
 *
 * Shape 3: `group.subject` (ask-groups.ts `askSubject` — the shared work
 * anchor for a decision group) is a MIXED id-space: an `mt#N` Minsky task
 * ref, a `gh#N` GitHub issue ref, or another producer-supplied string.
 * <EntityRef> assumes a known RoutableEntityType, so only the `mt#N` case is
 * routed through it; a mis-sniffed `gh#` must NOT render as a broken Minsky
 * link (per this task's spec).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AsksPage, GroupSubjectBadge } from "./AsksPage";
import type { AskItem } from "../widgets/AskDetail";
import { ProjectProvider } from "../lib/project-context";

const originalFetch = global.fetch;

/**
 * The ask ROW's expand toggle, addressed by its aria-label.
 *
 * NOT `button[aria-expanded]` (mt#3347): this page's filter dropdowns are now
 * Radix Selects, whose trigger is also a `button[aria-expanded]` and sits
 * EARLIER in the DOM — so the broad selector silently matches a filter
 * control instead of the row under test.
 */
const ROW_EXPAND_SELECTOR = 'button[aria-label="Expand question"]';

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function fallback(): Response {
  return jsonResponse({ state: "degraded", reason: "not mocked" });
}

function renderBadge(subject: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GroupSubjectBadge subject={subject} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AsksPage GroupSubjectBadge — Shape 3: group.subject mixed id-space (mt#3187)", () => {
  test("an mt# subject routes through EntityRef as a working task link", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return jsonResponse({ tasks: [{ id: "mt#77", title: "Some task", status: "READY" }] });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container } = renderBadge("mt#77");
    const link = container.querySelector('a[href="/tasks/mt%2377"]');
    expect(link).not.toBeNull();
    // children mode: exact prior text (bare subject), no dense-row line-height growth.
    expect(link?.textContent).toBe("mt#77");
    await waitFor(() => expect(link?.textContent).toBe("mt#77"));
  });

  test("a gh# subject stays plain text — NOT rendered as a broken Minsky link", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const { container } = renderBadge("gh#1761");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("gh#1761");
  });

  test("an unrecognized subject shape also stays plain text", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const { container } = renderBadge("something-else");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("something-else");
  });
});

// ---------------------------------------------------------------------------
// Row layout invariants (mt#3246)
//
// jsdom does no layout, so geometry is verified live against the running
// cockpit (this task's acceptance test 2). What IS assertable here — and what
// the regression actually consisted of — is the STRUCTURAL contract that makes
// the geometry work: long producer-supplied option labels must not sit on the
// title's line, must not be pinned unshrinkable, and must not be reachable
// only by horizontal scroll.
// ---------------------------------------------------------------------------

const LONG_OPTION_LABELS = [
  "GitHub Actions migrate-on-merge (recommended!!)",
  "Railway pre-deploy / release command per service",
  "Supabase CLI migration deploy from a CI runner..",
];

function askWithLongOptions(): AskItem {
  return {
    id: "1f0a5cfe-0000-4000-8000-000000000001",
    shortId: "ask#3346",
    kind: "direction.decide",
    state: "routed",
    title: "mt#2505: which deploy-keyed migration mechanism replaces boot-time auto-migrate",
    question:
      "mt#2505 decouples schema migration from process boot: it flips MINSKY_AUTO_MIGRATE " +
      "default OFF so no binary migrates on start. Pick the replacement mechanism.",
    requestor: "plan-task agent (mt#2505 investigation)",
    parentTaskId: "mt#2505",
    options: LONG_OPTION_LABELS.map((label, i) => ({
      label,
      value: String.fromCharCode(97 + i),
      description: `description for option ${String.fromCharCode(65 + i)}`,
    })),
    createdAt: new Date(Date.now() - 39 * 24 * 60 * 60 * 1000).toISOString(),
    windowMissedCount: 0,
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Resolved view (mt#4092)
//
// The originating incident: the principal resolved an ask by accident and had
// no way back to it. `/api/asks` only ever returned pending operator asks, so a
// closed ask was reachable if — and only if — a deeplink to it happened to
// survive somewhere. These tests exercise the path that replaces "happened to
// survive": the pending/resolved control on this page.
// ---------------------------------------------------------------------------

function terminalAsk(overrides: Partial<AskItem> & Pick<AskItem, "id" | "title">): AskItem {
  return {
    kind: "direction.decide",
    state: "closed",
    question: "Which way?",
    requestor: "test-agent",
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    closedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    windowMissedCount: 0,
    metadata: {},
    ...overrides,
  };
}

/** Serve the pending queue and the terminal list from two different URLs. */
function renderAsksPageWithViews(pending: AskItem[], terminal: AskItem[]) {
  const askUrls: string[] = [];
  let queryClient: QueryClient;
  global.fetch = mock(async (url: string) => {
    if (url.startsWith("/api/asks")) {
      askUrls.push(url);
      return url.includes("state=terminal")
        ? jsonResponse({
            asks: terminal,
            total: terminal.length,
            returned: terminal.length,
            truncated: false,
          })
        : jsonResponse({ asks: pending, total: pending.length });
    }
    return fallback();
  }) as unknown as typeof fetch;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProjectProvider>
          <AsksPage />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...result, askUrls, queryClient };
}

/** Drive the pending/resolved control the way Radix expects under happy-dom. */
function switchTo(label: "Pending" | "Resolved") {
  const viewSelect = screen.getByLabelText("View");
  fireEvent.keyDown(viewSelect, { key: "Enter" });
  fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("AsksPage resolved view (mt#4092)", () => {
  test("a resolved ask is reachable from the page — no deeplink required", async () => {
    const closed = terminalAsk({ id: "closed-1", title: "the accidentally resolved one" });
    renderAsksPageWithViews([], [closed]);

    await waitFor(() => expect(screen.getByText("No pending asks")).toBeDefined());
    expect(screen.queryByText("the accidentally resolved one")).toBeNull();

    switchTo("Resolved");

    await waitFor(() => expect(screen.getByText("the accidentally resolved one")).toBeDefined());
  });

  test("an ask in EACH terminal state is reachable by that same path", async () => {
    renderAsksPageWithViews(
      [],
      [
        terminalAsk({ id: "c", title: "closed ask", state: "closed" }),
        terminalAsk({ id: "x", title: "cancelled ask", state: "cancelled" }),
        terminalAsk({ id: "e", title: "expired ask", state: "expired" }),
      ]
    );

    await waitFor(() => expect(screen.getByText("No pending asks")).toBeDefined());
    switchTo("Resolved");

    await waitFor(() => expect(screen.getByText("closed ask")).toBeDefined());
    expect(screen.getByText("cancelled ask")).toBeDefined();
    expect(screen.getByText("expired ask")).toBeDefined();
  });

  test("the default view asks for no state filter, and shows no terminal ask", async () => {
    const pending = askWithLongOptions();
    const { askUrls } = renderAsksPageWithViews(
      [pending],
      [terminalAsk({ id: "closed-1", title: "should not appear by default" })]
    );

    await waitFor(() => expect(screen.getByText(pending.title)).toBeDefined());

    expect(screen.queryByText("should not appear by default")).toBeNull();
    // Not merely "no terminal row rendered" — the request itself carries no
    // filter, which is what keeps every other consumer of this endpoint on its
    // current result set.
    expect(askUrls.every((u) => !u.includes("state="))).toBe(true);
  });

  test("a resolved row offers no actions — there is nothing left to decide", async () => {
    renderAsksPageWithViews(
      [],
      [
        terminalAsk({
          id: "closed-1",
          title: "already decided",
          options: [
            { label: "Ship it", value: "a" },
            { label: "Hold", value: "b" },
          ],
        }),
      ]
    );

    await waitFor(() => expect(screen.getByText("No pending asks")).toBeDefined());
    switchTo("Resolved");

    await waitFor(() => expect(screen.getByText("already decided")).toBeDefined());
    expect(screen.queryByRole("button", { name: "Defer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ship it" })).toBeNull();
  });

  test("the resolved view does not poison the shared cache the home band reads", async () => {
    const pending = askWithLongOptions();
    const { queryClient } = renderAsksPageWithViews(
      [pending],
      [terminalAsk({ id: "closed-1", title: "already decided" })]
    );

    await waitFor(() => expect(screen.getByText(pending.title)).toBeDefined());
    switchTo("Resolved");
    await waitFor(() => expect(screen.getByText("already decided")).toBeDefined());

    // ["asks", selectedSlug] is shared with the home TriageBand (mt#4731:
    // selectedSlug joined the key, null here since no project is selected in
    // this test's ProjectProvider). If the resolved view wrote through it,
    // the home page would start showing closed asks as things that need the
    // principal — the exact signal degradation this task must not cause, and
    // one no assertion about THIS page would catch.
    const shared = queryClient.getQueryData(["asks", null]) as
      | { asks: AskItem[] }
      | undefined;
    expect(shared?.asks.map((a) => a.id)).toEqual([pending.id]);
  });

  test("a terminal state that is NOT a plain close is named on the row", async () => {
    renderAsksPageWithViews([], [terminalAsk({ id: "e", title: "timed out", state: "expired" })]);

    await waitFor(() => expect(screen.getByText("No pending asks")).toBeDefined());
    switchTo("Resolved");

    // "expired" means the ask went away WITHOUT the operator answering — the
    // discriminator someone hunting a lost decision actually needs.
    await waitFor(() => expect(screen.getByText("expired")).toBeDefined());
  });
});

function renderAsksPage(asks: AskItem[]) {
  global.fetch = mock(async (url: string) => {
    if (url.startsWith("/api/asks")) return jsonResponse({ asks, total: asks.length });
    return fallback();
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectProvider>
          <AsksPage />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AsksPage row layout — long option labels stay in-bounds (mt#3246)", () => {
  test("every inline action renders, including Defer, for a 3-long-option ask", async () => {
    renderAsksPage([askWithLongOptions()]);
    for (const label of LONG_OPTION_LABELS) {
      await waitFor(() => expect(screen.getByRole("button", { name: label })).toBeDefined());
    }
    expect(screen.getByRole("button", { name: "Defer" })).toBeDefined();
  });

  test("the action bar is a wrapping band, NOT an unshrinkable cell on the title line", async () => {
    const { container } = renderAsksPage([askWithLongOptions()]);
    const optionButton = await waitFor(() =>
      screen.getByRole("button", { name: LONG_OPTION_LABELS[0] as string })
    );
    const bar = optionButton.parentElement as HTMLElement;

    // The bar wraps its own buttons rather than forcing one long line...
    expect(bar.className).toContain("flex-wrap");
    // ...and never pins itself at natural width, which is what pushed Defer
    // and the open-detail affordance off-screen.
    expect(bar.className).not.toContain("flex-shrink-0");

    // It is a sibling band below the title line, not a cell inside it.
    const titleLine = container.querySelector(ROW_EXPAND_SELECTOR)?.parentElement;
    expect(titleLine).not.toBeNull();
    expect(titleLine?.contains(bar)).toBe(false);
  });

  test("a long option label is width-capped and truncates, with the full text on hover", async () => {
    const label = LONG_OPTION_LABELS[1] as string;
    renderAsksPage([askWithLongOptions()]);
    const optionButton = await waitFor(() => screen.getByRole("button", { name: label }));

    expect(optionButton.className).toContain("max-w-[22rem]");
    expect(optionButton.querySelector(".truncate")?.textContent).toBe(label);
    expect(optionButton.getAttribute("title")).toBe(`${label} — description for option B`);
  });

  test("the title truncates inside an overflow-clipped button so it cannot paint over the metadata cells", async () => {
    const ask = askWithLongOptions();
    const { container } = renderAsksPage([ask]);
    const titleButton = await waitFor(() => {
      const el = container.querySelector(ROW_EXPAND_SELECTOR);
      if (!el) throw new Error("title button not rendered yet");
      return el as HTMLElement;
    });

    expect(titleButton.className).toContain("overflow-hidden");
    expect(titleButton.className).toContain("min-w-0");
    const title = [...titleButton.querySelectorAll("span")].find(
      (s) => s.textContent === ask.title
    );
    expect(title?.className).toContain("truncate");
  });

  test("the consequence line declares wanted width so the actions wrap beneath it", async () => {
    const { container } = renderAsksPage([askWithLongOptions()]);
    const consequence = await waitFor(() => {
      const el = container.querySelector("p.truncate");
      if (!el) throw new Error("consequence line not rendered yet");
      return el as HTMLElement;
    });
    // basis-* is load-bearing: flex line breaking uses the flex BASE size, so a
    // zero-basis consequence would share its line with a ~900px action bar and
    // collapse to an ellipsis.
    expect(consequence.className).toContain("basis-64");
    expect(consequence.className).toContain("min-w-0");
  });
});

// ---------------------------------------------------------------------------
// Option-letter prefix normalization in the inbox (mt#3253)
//
// Collapsed rows render the options as ordered buttons and the expanded row
// renders an explicit letter. In both, a producer-supplied "[a] " / "B — "
// marker is redundant — and under the row's `max-w-[22rem]` cap (mt#3246) those
// characters cost real label text.
// ---------------------------------------------------------------------------

function askWithPrefixedOptions(): AskItem {
  return {
    id: "1f0a5cfe-0000-4000-8000-000000000002",
    shortId: "ask#3398",
    kind: "direction.decide",
    state: "routed",
    title: "Which deploy-keyed migration mechanism?",
    question: "Pick the replacement mechanism for boot-time auto-migrate.",
    requestor: "plan-task agent",
    parentTaskId: "mt#2505",
    options: [
      { label: "[a] GitHub Actions migrate-on-merge", value: "a" },
      { label: "B — Railway pre-deploy command", value: "b" },
      { label: "Adopt fully — no marker here", value: "c" },
    ],
    createdAt: new Date().toISOString(),
    windowMissedCount: 0,
    metadata: {},
  };
}

describe("AsksPage option labels — redundant letter markers stripped (mt#3253)", () => {
  test("an inline action button drops the bracketed marker", async () => {
    renderAsksPage([askWithPrefixedOptions()]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "GitHub Actions migrate-on-merge" })).toBeDefined()
    );
    expect(
      screen.queryByRole("button", { name: "[a] GitHub Actions migrate-on-merge" })
    ).toBeNull();
  });

  test("an inline action button drops the em-dash marker", async () => {
    renderAsksPage([askWithPrefixedOptions()]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Railway pre-deploy command" })).toBeDefined()
    );
  });

  test("a label with no marker is left exactly as authored", async () => {
    renderAsksPage([askWithPrefixedOptions()]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Adopt fully — no marker here" })).toBeDefined()
    );
  });

  test("the button tooltip carries the normalized label, matching what is shown", async () => {
    renderAsksPage([askWithPrefixedOptions()]);
    const button = await waitFor(() =>
      screen.getByRole("button", { name: "GitHub Actions migrate-on-merge" })
    );
    expect(button.getAttribute("title")).toBe("GitHub Actions migrate-on-merge");
  });

  test("the expanded option list renders one letter, not two", async () => {
    const { container } = renderAsksPage([askWithPrefixedOptions()]);
    const expand = await waitFor(() => {
      const el = container.querySelector(ROW_EXPAND_SELECTOR);
      if (!el) throw new Error("row not rendered yet");
      return el as HTMLElement;
    });
    fireEvent.click(expand);
    const list = container.querySelector("ul");
    expect(list?.textContent).toContain("A. GitHub Actions migrate-on-merge");
    expect(list?.textContent).not.toContain("A. [a]");
    expect(list?.textContent).toContain("B. Railway pre-deploy command");
    expect(list?.textContent).not.toContain("B. B —");
  });
});

// ---------------------------------------------------------------------------
// Expanded-row Markdown rendering (mt#3639)
//
// Ask questions are agent-authored Markdown. This surface rendered them as
// `whitespace-pre-wrap` text, so a GFM comparison table reached the operator as
// literal `| --- |` rows and a bolded lead kept its asterisks — while
// /ask/:id rendered the SAME field correctly through <Prose>.
//
// The three task ids in the fixture are deliberately distinct: `mt#77` is the
// parent (which the row header already links), `mt#78` lives in the question,
// and `mt#79` lives in an option description. Asserting on the two body ids
// keeps these tests from passing on the header's pre-existing link.
// ---------------------------------------------------------------------------

const MARKDOWN_QUESTION = [
  "**Decide what to do with mt#78.** The evidence has firmed since filing.",
  "",
  "| metric | before | after |",
  "| --- | --- | --- |",
  "| median rounds | 10.0 | 10.0 |",
  "| median input tokens | ~609k | ~396k |",
].join("\n");

function askWithMarkdownQuestion(): AskItem {
  return {
    id: "1f0a5cfe-0000-4000-8000-000000000002",
    shortId: "ask#6768",
    kind: "direction.decide",
    state: "routed",
    title: "Reviewer round-budget: rounds didn't move, but input tokens fell 35%",
    question: MARKDOWN_QUESTION,
    requestor: "unattributed agent",
    parentTaskId: "mt#77",
    options: [
      { label: "Ship it", value: "a", description: "Merge. Post-deploy watch tracked at mt#79." },
    ],
    createdAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    windowMissedCount: 0,
    metadata: {},
  };
}

/** `renderAsksPage`, plus a populated entity index (it fetches /api/tasks/ids). */
function renderAsksPageWithTaskIds(asks: AskItem[], ids: string[]) {
  global.fetch = mock(async (url: string) => {
    if (url.startsWith("/api/asks")) return jsonResponse({ asks, total: asks.length });
    if (url.startsWith("/api/tasks/ids")) return jsonResponse({ ids });
    if (url.startsWith("/api/tasks/meta")) {
      return jsonResponse({
        tasks: ids.map((id) => ({ id, title: `Title ${id}`, status: "READY" })),
      });
    }
    return fallback();
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectProvider>
          <AsksPage />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Expand the first row and hand back the container. */
async function expandFirstRow(container: HTMLElement): Promise<void> {
  const expand = await waitFor(() => {
    const el = container.querySelector(ROW_EXPAND_SELECTOR);
    if (!el) throw new Error("row not rendered yet");
    return el as HTMLElement;
  });
  fireEvent.click(expand);
}

describe("AsksPage expanded row renders the question as Markdown (mt#3639)", () => {
  test("a GFM table renders as a real table, not literal pipe rows", async () => {
    const { container } = renderAsksPage([askWithMarkdownQuestion()]);
    await expandFirstRow(container);

    const table = await waitFor(() => {
      const t = container.querySelector("table");
      if (!t) throw new Error("table not rendered");
      return t;
    });
    // MARKDOWN_QUESTION declares a 3-column header, a delimiter row, and two
    // data rows: the delimiter must become table structure (not a third data
    // row, and not literal text), so the body row count is exactly 2.
    expect(Array.from(table.querySelectorAll("th")).map((th) => th.textContent)).toEqual([
      "metric",
      "before",
      "after",
    ]);
    expect(table.querySelectorAll("tbody tr").length).toBe(2);
    expect(container.textContent).not.toContain("| --- |");
    expect(container.textContent).not.toContain("| metric |");
  });

  test("the bolded lead renders as emphasis, with no literal asterisks left over", async () => {
    const { container } = renderAsksPage([askWithMarkdownQuestion()]);
    await expandFirstRow(container);

    const strong = await waitFor(() => {
      const el = container.querySelector("strong");
      if (!el) throw new Error("emphasis not rendered");
      return el;
    });
    expect(strong.textContent).toContain("Decide what to do with mt#78.");
    expect(container.textContent).not.toContain("**");
  });

  test("a bare task ref in the question links when the entity index knows it", async () => {
    const { container } = renderAsksPageWithTaskIds(
      [askWithMarkdownQuestion()],
      ["mt#77", "mt#78", "mt#79"]
    );
    await expandFirstRow(container);
    await waitFor(() => {
      if (!container.querySelector('a[href="/tasks/mt%2378"]')) throw new Error("no question link");
    });
  });

  test("an option description is linkified the way the detail page linkifies it", async () => {
    const { container } = renderAsksPageWithTaskIds(
      [askWithMarkdownQuestion()],
      ["mt#77", "mt#78", "mt#79"]
    );
    await expandFirstRow(container);
    await waitFor(() => {
      if (!container.querySelector('a[href="/tasks/mt%2379"]')) throw new Error("no option link");
    });
  });

  test("an empty entity index leaves the refs as plain text, not broken links", async () => {
    // renderAsksPage mocks only /api/asks; /api/tasks/ids falls through to the
    // degraded fallback, which useEntityIndex tolerates as an empty index.
    const { container } = renderAsksPage([askWithMarkdownQuestion()]);
    await expandFirstRow(container);

    await waitFor(() => {
      if (!container.querySelector("table")) throw new Error("question not rendered yet");
    });
    expect(container.querySelector('a[href="/tasks/mt%2378"]')).toBeNull();
    expect(container.querySelector('a[href="/tasks/mt%2379"]')).toBeNull();
    expect(container.textContent).toContain("mt#78");
  });

  test("a queue of collapsed rows never builds the entity index", async () => {
    // The index hook mounts with the EXPANDED body, not the row — otherwise
    // every row in the inbox pays to rebuild the id-set Map. /api/tasks/ids is
    // fetched by useEntityIndex and by nothing else on this page, so its
    // absence from the call log is the discriminator.
    const urls: string[] = [];
    const asks = [0, 1, 2].map((i) => ({
      ...askWithMarkdownQuestion(),
      id: `1f0a5cfe-0000-4000-8000-00000000001${i}`,
      parentTaskId: `mt#8${i}`,
    }));
    global.fetch = mock(async (url: string) => {
      urls.push(url);
      if (url.startsWith("/api/asks")) return jsonResponse({ asks, total: asks.length });
      return fallback();
    }) as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ProjectProvider>
            <AsksPage />
          </ProjectProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Expand question" }).length).toBe(3)
    );
    expect(urls.some((u) => u.startsWith("/api/tasks/ids"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inline action feedback (mt#4503)
//
// The inbox is the surface where a lost answer is most invisible: the row is
// one of many, and before this change a failed inline resolve cleared the
// pending marker and re-rendered the row exactly as an idle one. Nothing said
// the answer had not landed, and the ask simply stayed in the list.
// ---------------------------------------------------------------------------

/**
 * Render the inbox with a resolve endpoint that answers `status`.
 *
 * Uses the real `Response` constructor rather than this file's `jsonResponse`
 * stub: `resolveAsk` reads `res.status` and calls `res.text()` on a failure, and
 * the stub object has neither.
 */
function renderAsksPageWithResolve(asks: AskItem[], status: number, body: unknown) {
  global.fetch = mock(async (url: string) => {
    if (url.includes("/resolve")) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith("/api/asks")) return jsonResponse({ asks, total: asks.length });
    return fallback();
  }) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectProvider>
          <AsksPage />
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AsksPage inline actions report their own outcome (mt#4503)", () => {
  test("a failed inline resolve leaves the row with an error naming the status", async () => {
    renderAsksPageWithResolve([askWithLongOptions()], 500, { error: "boom" });

    const button = await waitFor(() =>
      screen.getByRole("button", { name: LONG_OPTION_LABELS[0] as string })
    );
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId("inline-ask-error")).toBeDefined());
    const error = screen.getByTestId("inline-ask-error");
    expect(error.textContent).toContain("Your response was not saved");
    expect(error.textContent).toContain("500");

    // The row is still answerable — a failure must not strand the ask.
    expect(
      (screen.getByRole("button", { name: LONG_OPTION_LABELS[0] as string }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });

  test("at rest a row shows neither a status line nor an error", async () => {
    renderAsksPageWithResolve([askWithLongOptions()], 200, { ok: true });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: LONG_OPTION_LABELS[0] as string })).toBeDefined()
    );
    expect(screen.queryByTestId("inline-ask-status")).toBeNull();
    expect(screen.queryByTestId("inline-ask-error")).toBeNull();
    expect(screen.queryByTestId("pending-spinner")).toBeNull();
  });
});
