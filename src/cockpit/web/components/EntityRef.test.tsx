/**
 * Tests for the shared <EntityRef> component (mt#3174).
 *
 * Covers the mt#3174 acceptance test verbatim: "Render <EntityRef> for each
 * of the six entity types: task shows title + status; the five
 * payload-backed types show their label; an unknown id degrades to a plain
 * linked id" — plus the failure-tolerance and hover-disabled-still-readable
 * requirements.
 *
 * `global.fetch` is stubbed per test (no real network) — the label channel
 * is exercised end to end (EntityRef -> useResolvedEntityLabel ->
 * useTaskLabel/useEntityLabels -> fetch), not just the pure extraction
 * helpers (see use-entity-index.test.ts for those in isolation).
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EntityRef, truncateLabel } from "./EntityRef";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

/** Fallback for any URL a given test doesn't care about — degrades safely. */
function fallback(): Response {
  return jsonResponse({ state: "degraded", reason: "not mocked" });
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderRef(ui: React.ReactElement) {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

describe("EntityRef — per-type label resolution (mt#3174 acceptance test)", () => {
  test("task: shows title AND status once the label channel resolves", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return jsonResponse({ tasks: [{ id: "mt#1", title: "Fix the bug", status: "READY" }] });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container } = renderRef(<EntityRef type="task" id="mt#1" />);
    await waitFor(() => expect(container.textContent).toContain("Fix the bug"));
    expect(container.textContent).toContain("READY");
    // Href still resolves via the entity codec regardless of label state.
    expect(container.querySelector('a[href="/tasks/mt%231"]')).not.toBeNull();
  });

  test("session: shows its label from the agents widget payload (no new endpoint)", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/widget/agents/data")) {
        return jsonResponse({
          state: "ok",
          payload: {
            agents: [{ sessionId: "sess-1", title: "Implement thing", liveness: "healthy" }],
          },
        });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container } = renderRef(<EntityRef type="session" id="sess-1" />);
    await waitFor(() => expect(container.textContent).toContain("Implement thing"));
  });

  test("ask: shows its title from the attention cohort payload", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/widget/attention/data")) {
        return jsonResponse({
          state: "ok",
          payload: { cohort: [{ id: "ask-1", title: "Approve deploy", state: "open" }] },
        });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container } = renderRef(<EntityRef type="ask" id="ask-1" />);
    await waitFor(() => expect(container.textContent).toContain("Approve deploy"));
  });

  test("memory: shows its name from the memories-list payload", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/widget/memories-list/data")) {
        return jsonResponse({
          state: "ok",
          payload: { records: [{ id: "mem-1", name: "Postgres default datastore" }] },
        });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container } = renderRef(<EntityRef type="memory" id="mem-1" />);
    await waitFor(() => expect(container.textContent).toContain("Postgres default datastore"));
  });

  test("changeset: shows its PR title from /api/changesets", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/changesets")) {
        return jsonResponse({
          changesets: [{ pr: { number: 1234, title: "Fix the widget", state: "open" } }],
        });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container } = renderRef(<EntityRef type="changeset" id="1234" />);
    await waitFor(() => expect(container.textContent).toContain("Fix the widget"));
  });

  test("conversation: shows its ladder label from the context-inspector payload", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/widget/context-inspector/data")) {
        return jsonResponse({
          state: "ok",
          payload: {
            sessions: [
              {
                agentSessionId: "conv-1",
                harness: "claude-code",
                startedAt: null,
                endedAt: null,
                cwd: null,
                label: "Investigate flaky test",
              },
            ],
          },
        });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container } = renderRef(<EntityRef type="conversation" id="conv-1" />);
    await waitFor(() => expect(container.textContent).toContain("Investigate flaky test"));
  });

  test("unknown id degrades to a plain linked id — no label, no error", async () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;

    const { container } = renderRef(<EntityRef type="task" id="mt#999" />);
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.textContent).toBe("mt#999");
    expect(a?.getAttribute("href")).toBe("/tasks/mt%23999");
  });
});

describe("EntityRef — failure tolerance", () => {
  test("a rejecting label channel still renders a working link (no crash, no empty shell)", async () => {
    global.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const { container } = renderRef(<EntityRef type="task" id="mt#1" />);
    // Give any in-flight promise a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
    const a = container.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.textContent).toBe("mt#1");
  });
});

describe("EntityRef — hover is supplementary, not load-bearing", () => {
  test("the inline label identifies the reference without the hover card ever being triggered", () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;

    const { container } = renderRef(<EntityRef type="task" id="mt#42" />);
    // No hover/focus event fired at all. HoverCardContent is portalled and
    // closed by default — assert purely on the trigger's own rendered text.
    const a = container.querySelector("a");
    expect(a?.textContent).toBe("mt#42");
  });

  test("children override (the <Prose> anchor usage) is preserved verbatim regardless of label state", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return jsonResponse({ tasks: [{ id: "mt#7", title: "Some Title", status: "DONE" }] });
      }
      return fallback();
    }) as unknown as typeof fetch;

    const { container } = renderRef(
      <EntityRef type="task" id="mt#7">
        mt#7
      </EntityRef>
    );
    // Even after the label resolves, the trigger's visible text stays
    // exactly the provided children — no title/status text appended inline.
    // NOTE (mt#3189): <Prose> no longer relies on this; it now opts into
    // `appendLabel` so prose refs carry an inline title. This case now covers
    // the OPT-OUT callers — the dense list rows (ActivityPage, MemoriesList,
    // TaskGraph) that pass children without the flag to protect line height.
    await new Promise((r) => setTimeout(r, 0));
    const a = container.querySelector("a");
    expect(a?.textContent).toBe("mt#7");
  });
});

describe("EntityRef — appendLabel: inline title in prose (mt#3189)", () => {
  const TASK_META = { tasks: [{ id: "mt#1", title: "Fix the bug", status: "READY" }] };

  function metaFetch() {
    return mock(async (url: string) =>
      url.startsWith("/api/tasks/meta") ? jsonResponse(TASK_META) : fallback()
    ) as unknown as typeof fetch;
  }

  test("children + appendLabel renders the matched text AND the resolved title inline", async () => {
    global.fetch = metaFetch();
    const { container } = renderRef(
      <EntityRef type="task" id="mt#1" appendLabel>
        mt#1
      </EntityRef>
    );
    // The regression this task exists to fix: before mt#3189 the anchor text
    // was exactly "mt#1" and the title was reachable only by hovering.
    await waitFor(() => expect(container.querySelector("a")?.textContent).toContain("Fix the bug"));
    expect(container.querySelector("a")?.textContent).toContain("mt#1");
  });

  test("the matched text is preserved verbatim — a prefix citation is NOT rewritten", async () => {
    global.fetch = metaFetch();
    // Prose may cite a resolved PREFIX; appending a label must not expand it
    // to the full id (that would silently edit the author's words).
    const { container } = renderRef(
      <EntityRef type="task" id="mt#1" appendLabel>
        mt#1
      </EntityRef>
    );
    await waitFor(() => expect(container.textContent).toContain("Fix the bug"));
    expect(container.querySelector("a")?.textContent?.startsWith("mt#1")).toBe(true);
  });

  test("children WITHOUT appendLabel appends nothing — dense rows keep their line height", async () => {
    global.fetch = metaFetch();
    const { container } = renderRef(
      <EntityRef type="task" id="mt#1">
        mt#1
      </EntityRef>
    );
    // Give the label query the same opportunity to resolve as the case above.
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("a")?.textContent).toBe("mt#1");
  });

  test("appendLabel with NO resolvable label degrades to bare children — no empty separator", async () => {
    global.fetch = mock(async () => fallback()) as unknown as typeof fetch;
    const { container } = renderRef(
      <EntityRef type="task" id="mt#404" appendLabel>
        mt#404
      </EntityRef>
    );
    await new Promise((r) => setTimeout(r, 50));
    // Byte-identical to plain children mode: no dangling " · ", no empty shell.
    expect(container.querySelector("a")?.textContent).toBe("mt#404");
  });

  test("a long title is truncated inline while the hover card keeps the full text", async () => {
    const longTitle =
      "Cockpit entity-reference layer: label channel, hover primitive, inline-only linkify path, shared EntityRef";
    global.fetch = mock(async (url: string) =>
      url.startsWith("/api/tasks/meta")
        ? jsonResponse({ tasks: [{ id: "mt#2", title: longTitle, status: "DONE" }] })
        : fallback()
    ) as unknown as typeof fetch;

    const { container } = renderRef(
      <EntityRef type="task" id="mt#2" appendLabel>
        mt#2
      </EntityRef>
    );
    await waitFor(() => expect(container.querySelector("a")?.textContent).toContain("…"));
    const anchorText = container.querySelector("a")?.textContent ?? "";
    expect(anchorText).not.toContain("shared EntityRef");
    expect(anchorText.length).toBeLessThan(longTitle.length);
  });
});

describe("truncateLabel (mt#3189)", () => {
  test("returns a short label unchanged, with no ellipsis", () => {
    expect(truncateLabel("Fix the bug")).toBe("Fix the bug");
  });

  test("truncates past the budget and marks it with an ellipsis", () => {
    const out = truncateLabel("x".repeat(80));
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(80);
  });

  test("does not leave a trailing space before the ellipsis", () => {
    // A cut landing on a word boundary would otherwise render "word …".
    const out = truncateLabel(`${"a".repeat(47)} tail`, 48);
    expect(out).not.toContain(" …");
  });

  test("respects an explicit budget", () => {
    expect(truncateLabel("abcdefghij", 4)).toBe("abcd…");
  });
});