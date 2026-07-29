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

function renderAsksPage(asks: AskItem[]) {
  global.fetch = mock(async (url: string) => {
    if (url.startsWith("/api/asks")) return jsonResponse({ asks, total: asks.length });
    return fallback();
  }) as unknown as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AsksPage />
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
