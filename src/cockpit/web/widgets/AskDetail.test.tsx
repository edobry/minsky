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
import { ENTITY_REF_ATTR } from "../lib/peek-dismiss";
import { AskDetail, type AskItem, type AskActionInFlight } from "./AskDetail";

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

function renderAsk(
  ask: AskItem,
  actionState: { acting?: AskActionInFlight | null; actionError?: unknown } = {}
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AskDetail
          ask={ask}
          onResolve={() => {}}
          onDefer={() => {}}
          onEscalate={() => {}}
          acting={actionState.acting ?? null}
          actionError={actionState.actionError}
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
    // ...and it carries the same affordances the question above it does
    // (mt#4630). Until then this option ref was a bare anchor: no hover card,
    // no peek — while the identical ref inside `ask.question`, rendered by
    // <Prose> a few lines up this same component, had both.
    expect(link?.hasAttribute(ENTITY_REF_ATTR)).toBe(true);
    expect(link?.hasAttribute("data-state")).toBe(true);
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
    // Same affordance requirement as the option-label case above (mt#4630).
    const link = container.querySelector('a[href="/tasks/mt%23201"]');
    expect(link?.hasAttribute(ENTITY_REF_ATTR)).toBe(true);
    expect(link?.hasAttribute("data-state")).toBe(true);
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

describe("AskDetail — credential-request render mode (mt#4030)", () => {
  /**
   * The mt#4030 ↔ mt#4447 seam decision in test form: a `metadata` key selects
   * which control replaces the option buttons. These two tests pin the dispatch
   * — one that it fires on the payload, one that it does NOT fire without it.
   */
  const CREDENTIAL_REQUEST_ASK: Partial<AskItem> = {
    kind: "authorization.approve",
    state: "routed",
    title: "Add the Supabase service_role credential",
    question: "A queued step needs it.",
    metadata: { credentialRequest: { provider: "supabase-service-role" } },
  };

  function mockProviders() {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/credentials/providers")) {
        return jsonResponse({
          providers: [
            {
              id: "supabase-service-role",
              displayName: "Supabase service_role",
              acquireUrl: "https://supabase.com/dashboard/project/_/settings/api",
              scopeGuidance: "service_role, not the anon key",
            },
          ],
        });
      }
      return fallback();
    }) as unknown as typeof fetch;
  }

  test("a credential-request ask renders the masked form instead of approve/deny", async () => {
    mockProviders();
    renderAsk(baseAsk(CREDENTIAL_REQUEST_ASK));

    await waitFor(() => expect(screen.getByTestId("credential-request-form")).toBeTruthy());
    const input = screen.getByTestId("credential-request-token-input");
    expect(input.getAttribute("type")).toBe("password");

    // The lettered pair must be gone: an "A) Approve" here would settle the ask
    // without a credential ever being entered, which the presence-based resolver
    // would then never reconcile.
    expect(screen.queryByRole("button", { name: /^A\) Approve/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^B\) Deny/ })).toBeNull();
  });

  test("negative control: a plain authorization.approve ask still renders approve/deny and no form", async () => {
    mockProviders();
    renderAsk(baseAsk({ kind: "authorization.approve", state: "routed", metadata: {} }));

    expect(screen.queryByTestId("credential-request-form")).toBeNull();
    expect(screen.getByRole("button", { name: /^A\) Approve/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^B\) Deny/ })).toBeTruthy();
  });

  test("defer and escalate survive the render-mode switch", async () => {
    mockProviders();
    renderAsk(baseAsk(CREDENTIAL_REQUEST_ASK));

    await waitFor(() => expect(screen.getByTestId("credential-request-form")).toBeTruthy());
    expect(screen.getByRole("button", { name: /Defer/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Escalate/ })).toBeTruthy();
  });
});

describe("AskDetail — the in-flight action is visible and named (mt#4503)", () => {
  const TWO_OPTIONS = {
    state: "routed" as const,
    options: [
      { label: "Run it", value: "run" },
      { label: "Hold off", value: "hold" },
    ],
  };

  function optionButton(label: RegExp): HTMLButtonElement {
    return screen.getByRole("button", { name: label }) as HTMLButtonElement;
  }

  test("at rest, no control claims to be working", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    renderAsk(baseAsk(TWO_OPTIONS));

    expect(screen.queryByTestId("ask-action-status")).toBeNull();
    expect(screen.queryByTestId("pending-spinner")).toBeNull();
    expect(optionButton(/Run it/).disabled).toBe(false);
  });

  test("the spinner lands on the clicked option, and only on it", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    // The whole point of replacing the old `resolving: boolean`. A boolean could
    // say the panel was busy; it could not say WHICH of these two answers is the
    // one being saved, and that is the question an operator mid-click has.
    renderAsk(baseAsk(TWO_OPTIONS), { acting: { kind: "resolve", optionLetter: "B" } });

    const chosen = optionButton(/Hold off/);
    const sibling = optionButton(/Run it/);

    expect(chosen.querySelector('[data-testid="pending-spinner"]')).not.toBeNull();
    expect(chosen.getAttribute("aria-busy")).toBe("true");

    // The sibling is disabled — a second answer must not be sendable — but it
    // does NOT claim to be saving. Before mt#4503 both rendered identically.
    expect(sibling.disabled).toBe(true);
    expect(sibling.querySelector('[data-testid="pending-spinner"]')).toBeNull();
    expect(sibling.getAttribute("aria-busy")).toBeNull();
  });

  test("the status line says what is happening, and is announced", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    renderAsk(baseAsk(TWO_OPTIONS), { acting: { kind: "resolve", optionLetter: "A" } });

    const status = screen.getByTestId("ask-action-status");
    expect(status.textContent).toBe("Saving your response…");
    // Not merely visual: a screen reader has to be told too, which is why the
    // button's own spinner is aria-hidden and this carries the announcement.
    expect(status.getAttribute("role")).toBe("status");
  });

  test("defer and escalate name themselves rather than borrowing the resolve wording", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;

    const { unmount } = renderAsk(baseAsk(TWO_OPTIONS), { acting: { kind: "defer" } });
    expect(screen.getByTestId("ask-action-status").textContent).toBe("Deferring…");
    expect(optionButton(/Defer/).getAttribute("aria-busy")).toBe("true");
    unmount();

    renderAsk(baseAsk(TWO_OPTIONS), { acting: { kind: "escalate" } });
    expect(screen.getByTestId("ask-action-status").textContent).toBe("Escalating…");
    expect(optionButton(/Escalate/).getAttribute("aria-busy")).toBe("true");
  });

  test("a failure is rendered where the operator clicked, with the server's own message", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    renderAsk(baseAsk(TWO_OPTIONS), {
      acting: null,
      actionError: new Error("resolve failed (409): Ask is in \"closed\" state"),
    });

    const error = screen.getByTestId("ask-action-error");
    expect(error.textContent).toContain("Your response was not saved");
    // The status code is what tells a 409 (someone else already answered) from a
    // 503 (persistence is down) — two failures with very different remedies.
    expect(error.textContent).toContain("409");
    // ErrorState's role="alert": a failure the operator did not ask about must
    // interrupt, where an in-progress status merely reports.
    expect(error.querySelector('[role="alert"]')).not.toBeNull();
  });

  test("an in-flight action supersedes a stale failure rather than stacking with it", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    // A retry after a failed attempt: the mutation has not cleared its previous
    // error yet, and showing "not saved" beneath a live spinner would read as a
    // second failure that has not happened.
    renderAsk(baseAsk(TWO_OPTIONS), {
      acting: { kind: "resolve", optionLetter: "A" },
      actionError: new Error("resolve failed (500): boom"),
    });

    expect(screen.getByTestId("ask-action-status").textContent).toBe("Saving your response…");
    expect(screen.queryByTestId("ask-action-error")).toBeNull();
  });
});
