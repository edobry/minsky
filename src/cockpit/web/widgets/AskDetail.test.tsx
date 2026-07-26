/**
 * AskDetail entity-reference adoption tests (mt#3175).
 *
 * Covers:
 *   - Shape 3: `ask.parentTaskId` renders through the shared <EntityRef>
 *     (a real link, not dead monospace text).
 *   - Shape 2: option label/description route through the inline-only
 *     `<LinkifiedText>` path (linkify without <Prose>'s block Markdown),
 *     and the stale mt#2556 "Plain text" comment is gone.
 *
 * `global.fetch` is stubbed (no real network) — QueryClientProvider is
 * required because both useEntityIndex (AskDetail) and useResolvedEntityLabel
 * (EntityRef, used inside <EntityRef>/<Prose>) call TanStack Query hooks.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AskDetail, type AskItem } from "./AskDetail";

const originalFetch = global.fetch;

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

function baseAsk(overrides: Partial<AskItem> = {}): AskItem {
  return {
    id: "ask-1",
    kind: "direction.decide",
    state: "detected",
    title: "Pick an approach",
    question: "Which way should we go?",
    requestor: "agent-1",
    createdAt: new Date().toISOString(),
    windowMissedCount: 0,
    metadata: {},
    ...overrides,
  };
}

function renderAsk(ask: AskItem) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AskDetail
          ask={ask}
          onResolve={() => {}}
          onDefer={() => {}}
          onEscalate={() => {}}
          resolving={false}
          onClose={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AskDetail — Shape 3: ask.parentTaskId (mt#3175)", () => {
  test("renders through <EntityRef> as a real link, not dead monospace text", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return jsonResponse({ tasks: [{ id: "mt#100", title: "Parent task", status: "READY" }] });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container } = renderAsk(baseAsk({ parentTaskId: "mt#100" }));
    const link = container.querySelector('a[href="/tasks/mt%23100"]');
    expect(link).not.toBeNull();
    // Default (no-children) EntityRef mode: bare id text at minimum.
    expect(link?.textContent).toContain("mt#100");
    await waitFor(() => expect(link?.textContent).toContain("Parent task"));
  });

  test("no parentTaskId renders no task link", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const { container } = renderAsk(baseAsk());
    expect(container.querySelector('a[href^="/tasks/"]')).toBeNull();
  });
});

describe("AskDetail — Shape 2: option label/description (mt#3175)", () => {
  test("an entity ref inside an option label linkifies via the inline-only path", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/ids")) {
        return jsonResponse({ ids: ["mt#200"] });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const ask = baseAsk({
      kind: "authorization.approve",
      options: [{ label: "Approve mt#200", value: "approve" }],
    });
    const { container } = renderAsk(ask);
    await waitFor(() => {
      expect(container.querySelector('a[href="/tasks/mt%23200"]')).not.toBeNull();
    });
    // Inline-only path: the resolved link's own immediate wrapper is the
    // option-label <span> (font-medium), never a react-markdown block <p> —
    // that's the whole point of not routing this site through <Prose>.
    const link = container.querySelector('a[href="/tasks/mt%23200"]');
    expect(link?.closest("span.font-medium")).not.toBeNull();
    expect(link?.closest("p")).toBeNull();
  });

  test("an entity ref inside an option description linkifies via the inline-only path", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/ids")) {
        return jsonResponse({ ids: ["mt#201"] });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const ask = baseAsk({
      kind: "authorization.approve",
      options: [{ label: "Approve", value: "approve", description: "See mt#201 for context" }],
    });
    const { container } = renderAsk(ask);
    await waitFor(() => {
      expect(container.querySelector('a[href="/tasks/mt%23201"]')).not.toBeNull();
    });
  });

  test("plain option text with no entity refs renders unchanged", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const ask = baseAsk({
      kind: "authorization.approve",
      options: [{ label: "Approve", value: "approve", description: "No refs here" }],
    });
    const { container } = renderAsk(ask);
    expect(container.textContent).toContain("Approve");
    expect(container.textContent).toContain("No refs here");
    expect(container.querySelector("a")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Option-letter prefix normalization at display (mt#3253)
//
// This surface renders the option letter itself ("A)" beside the label, and
// "A) <label>" on the resolve button), so a producer-supplied "B — " / "[b] "
// prefix doubles it. 35 of 200 labels in the live corpus carry one, and those
// rows are already persisted — normalization has to happen at render.
// ---------------------------------------------------------------------------

describe("AskDetail — option letter prefixes are not doubled (mt#3253)", () => {
  test("an em-dash-prefixed label renders one letter, not two", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const ask = baseAsk({
      options: [{ label: "B — boundary fix only", value: "b" }],
    });
    const { container } = renderAsk(ask);
    expect(container.textContent).toContain("boundary fix only");
    expect(container.textContent).not.toContain("B — boundary fix only");
  });

  test("a bracketed label renders without its marker", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const ask = baseAsk({
      options: [{ label: "[a] GitHub Actions migrate-on-merge", value: "a" }],
    });
    const { container } = renderAsk(ask);
    expect(container.textContent).toContain("GitHub Actions migrate-on-merge");
    expect(container.textContent).not.toContain("[a]");
  });

  test("the resolve BUTTON also renders one letter, not two", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const ask = baseAsk({
      options: [
        { label: "A: enroll now", value: "a" },
        { label: "B: defer", value: "b" },
      ],
    });
    renderAsk(ask);
    // The button composes its own "A)" prefix; the label must not add another.
    expect(screen.getByRole("button", { name: "A) enroll now" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "A) A: enroll now" })).toBeNull();
  });

  test("a label with no marker is left exactly as authored, em dash included", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const label = "Adopt fully — vocabulary + one-pager reframe";
    const ask = baseAsk({ options: [{ label, value: "adopt" }] });
    const { container } = renderAsk(ask);
    expect(container.textContent).toContain(label);
  });

  test("the option description is untouched by label normalization", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const ask = baseAsk({
      options: [{ label: "[a] Adopt", value: "a", description: "B — this is the description" }],
    });
    const { container } = renderAsk(ask);
    // Only the LABEL carries a rendered letter beside it; a description is
    // prose and must not be rewritten.
    expect(container.textContent).toContain("B — this is the description");
  });
});
