/**
 * Tests for the label channel added to use-entity-index.ts (mt#3174):
 * batching (K references -> 1 request) and failure tolerance for the task
 * label channel. Per-type label CONTENT (session/ask/memory/changeset/
 * conversation) is exercised end to end through `<EntityRef>` in
 * `../components/EntityRef.test.tsx` — this file covers the batching
 * mechanics that are specific to `use-entity-index.ts`'s `TaskMetaBatcher`
 * and are hard to observe from a single-component test.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { act, render, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EntityRef } from "../components/EntityRef";
import { useEntityIndex } from "./use-entity-index";
import { Prose } from "../components/Prose";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("Task label channel — batching (mt#3174 acceptance test)", () => {
  test('K simultaneously-mounted <EntityRef type="task"> references issue ONE /api/tasks/meta request, not K', async () => {
    const metaCalls: string[] = [];
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        metaCalls.push(url);
        return jsonResponse({
          tasks: [
            { id: "mt#1", title: "One", status: "TODO" },
            { id: "mt#2", title: "Two", status: "READY" },
            { id: "mt#3", title: "Three", status: "DONE" },
          ],
        });
      }
      // Every EntityRef also mounts the 5 non-task label queries
      // unconditionally (useResolvedEntityLabel calls useEntityLabels
      // regardless of type) — degrade those safely, they're not under test
      // here.
      return jsonResponse({ state: "degraded", reason: "not mocked" });
    }) as unknown as typeof fetch;

    const client = createTestQueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <EntityRef type="task" id="mt#1" />
          <EntityRef type="task" id="mt#2" />
          <EntityRef type="task" id="mt#3" />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(container.textContent).toContain("One");
      expect(container.textContent).toContain("Two");
      expect(container.textContent).toContain("Three");
    });

    // The batcher coalesces all three ids into a single request.
    expect(metaCalls.length).toBe(1);
    // And that one request actually carried all three ids (not just the
    // first mounted instance's).
    const url = new URL(metaCalls[0] as string, "http://localhost");
    // URLSearchParams.get() decodes the retrieved value, so the recovered
    // ids are back in display form (percent-encoding is only on the wire).
    const ids = (url.searchParams.get("ids") ?? "").split(",");
    expect(ids.sort()).toEqual(["mt#1", "mt#2", "mt#3"].sort());
  });

  test("a failing task-meta endpoint degrades every reference to a bare linked id — no crash", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/tasks/meta")) {
        return jsonResponse({ error: "unavailable" }, false);
      }
      return jsonResponse({ state: "degraded", reason: "not mocked" });
    }) as unknown as typeof fetch;

    const client = createTestQueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <EntityRef type="task" id="mt#10" />
          <EntityRef type="task" id="mt#11" />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Give the (failing) batched fetch a tick to settle.
    await new Promise((r) => setTimeout(r, 0));

    const anchors = container.querySelectorAll("a");
    expect(anchors.length).toBe(2);
    const texts = Array.from(anchors).map((a) => a.textContent);
    expect(texts).toEqual(["mt#10", "mt#11"]);
  });
});

/**
 * Freshness of the id-set (mt#3732).
 *
 * The bug these cover: the id-set was fetched once at mount and never
 * revalidated, so an entity created AFTER the view mounted was permanently
 * unlinkable there. Linkification is id-set gated, so "the id isn't in the set"
 * and "this isn't an entity" are indistinguishable at the render site — the ref
 * silently renders as plain text.
 *
 * The first test asserts on the options the running React tree actually
 * REGISTERED, read back off the query cache, rather than on the exported
 * constant — a constant can be correct while an entry that forgot to spread it
 * stays broken, which is the shape of the original defect.
 */

/** Renders `useEntityIndex` and hands the built index to `<Prose>`. */
function IndexProbe({ text }: { text: string }) {
  const entityIndex = useEntityIndex();
  return <Prose entityIndex={entityIndex}>{text}</Prose>;
}

/** Every query key `useEntityIndex` composes, in registration order. */
const ENTITY_INDEX_KEYS: unknown[][] = [
  ["entity-index", "tasks"],
  ["agents"],
  ["attention"],
  ["widget", "memories-list", "", "", true],
  ["entity-index", "changesets"],
  ["context-inspector", "sessions"],
];

/** Stubs every endpoint the index touches; `taskIds` drives /api/tasks/ids. */
function stubIndexFetch(taskIds: string[]): void {
  global.fetch = mock(async (url: string) => {
    if (String(url).startsWith("/api/tasks/ids")) return jsonResponse({ ids: taskIds });
    if (String(url).startsWith("/api/changesets")) return jsonResponse({ changesets: [] });
    return jsonResponse({ state: "degraded", reason: "not mocked" });
  }) as unknown as typeof fetch;
}

describe("useEntityIndex — id-set freshness (mt#3732)", () => {
  test("every composed query registers a 60s refetchInterval, and none polls a hidden tab", async () => {
    stubIndexFetch(["mt#1"]);
    const client = createTestQueryClient();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <IndexProbe text="hello" />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(client.getQueryCache().getAll().length).toBeGreaterThanOrEqual(
        ENTITY_INDEX_KEYS.length
      );
    });

    for (const key of ENTITY_INDEX_KEYS) {
      const query = client
        .getQueryCache()
        .getAll()
        .find((q) => JSON.stringify(q.queryKey) === JSON.stringify(key));
      expect(query, `no query registered for key ${JSON.stringify(key)}`).toBeDefined();

      const observers = query!.observers;
      expect(observers.length, `no observer for ${JSON.stringify(key)}`).toBeGreaterThan(0);
      // At least one observer must carry the interval — the entity-index one.
      // (A key shared with a widget that polls faster keeps its own shorter
      // interval; TanStack takes the shortest across observers, so this is a
      // floor on freshness, not an exact-equality claim about the key.)
      const intervals = observers.map((o) => o.options.refetchInterval);
      expect(intervals, `${JSON.stringify(key)} registered no refetchInterval`).toContain(60_000);
      // A hidden tab must stop polling: the default is false, and nothing here
      // may opt into background polling.
      for (const o of observers) {
        expect(o.options.refetchIntervalInBackground).not.toBe(true);
      }
    }
  });

  test("an already-rendered ref becomes a link when the refreshed id-set arrives — no remount", async () => {
    // The id-set as of mount does NOT know about mt#9999 (the entity is
    // created later, which is the driven-session case).
    stubIndexFetch(["mt#1"]);
    const client = createTestQueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <IndexProbe text="Moving mt#9999 to READY." />
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Before the refresh: gated off, so it renders as plain text.
    await waitFor(() => {
      expect(container.textContent).toContain("mt#9999");
    });
    expect(container.querySelector('a[href="/tasks/mt%239999"]')).toBeNull();

    // The next revalidation returns an id-set that now contains it. Writing
    // the fresh data straight into the cache is what a refetch does on
    // arrival; this asserts the already-mounted tree reacts to it.
    act(() => {
      client.setQueryData(["entity-index", "tasks"], ["mt#1", "mt#9999"]);
    });

    await waitFor(() => {
      expect(container.querySelector('a[href="/tasks/mt%239999"]')).not.toBeNull();
    });
    const anchor = container.querySelector('a[href="/tasks/mt%239999"]');
    expect(anchor?.textContent).toBe("mt#9999");
  });

  test("the zero-false-positive gate survives: an id that never joins the set stays plain text", async () => {
    stubIndexFetch(["mt#1"]);
    const client = createTestQueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <IndexProbe text="Moving mt#9999 to READY." />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(container.textContent).toContain("mt#9999");
    });

    // A refresh that still does not contain it must NOT produce a link.
    act(() => {
      client.setQueryData(["entity-index", "tasks"], ["mt#1", "mt#2"]);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("mt#9999");
    });
    expect(container.querySelector('a[href="/tasks/mt%239999"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The ask id channel (mt#4095)
//
// The alias map used to be built from the attention widget's cohort — pending
// operator asks in the active window — so an `ask#N` written in a memory, spec
// or transcript linkified while its ask was open and silently became plain
// text the moment it closed. Nothing errored, which is why it went unnoticed.
// ---------------------------------------------------------------------------

const CLOSED_ASK_UUID = "a902cba7-fd37-464a-842f-96fe38fe8bcc";

/**
 * Mock every channel `useEntityIndex` fetches. `askIds` is what this block
 * varies; the rest are empty so nothing else can produce the link under test.
 */
function mockIndexFetches(askIds: { shortId: string; id: string }[]) {
  global.fetch = mock(async (url: string) => {
    if (url.startsWith("/api/asks/ids")) return jsonResponse({ ids: askIds });
    if (url.startsWith("/api/tasks/ids")) return jsonResponse({ ids: [] });
    if (url.startsWith("/api/changesets")) return jsonResponse({ changesets: [] });
    // Widget payloads (agents / attention / memories-list / context-inspector).
    return jsonResponse({ state: "ok", payload: {} });
  }) as unknown as typeof fetch;
}

/** `Prose` takes the built index as a prop, so it needs `IndexProbe`. */
function renderProse(text: string) {
  const client = createTestQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <IndexProbe text={text} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ask short-id channel (mt#4095)", () => {
  test("a CLOSED ask's ask#N still resolves — the alias no longer depends on it being pending", async () => {
    // The attention payload is deliberately EMPTY here: under the old wiring
    // that alone made this ref unresolvable, so this asserts the new channel
    // is what carries it.
    mockIndexFetches([{ shortId: "ask#7754", id: CLOSED_ASK_UUID }]);

    const { container } = renderProse("Decided in ask#7754 last week.");

    await waitFor(() =>
      expect(container.querySelector(`a[href="/ask/${CLOSED_ASK_UUID}"]`)).not.toBeNull()
    );
  });

  test("the emitted target is the uuid, never the short id (ADR-029)", async () => {
    mockIndexFetches([{ shortId: "ask#7754", id: CLOSED_ASK_UUID }]);

    const { container } = renderProse("See ask#7754.");

    const link = await waitFor(() => {
      const a = container.querySelector("a[href^='/ask/']");
      if (!a) throw new Error("no ask link yet");
      return a;
    });
    const href = link.getAttribute("href") ?? "";
    expect(href).toBe(`/ask/${CLOSED_ASK_UUID}`);
    expect(href).not.toContain("ask#7754");
    expect(href).not.toContain("ask%237754");
    // The visible text keeps the short id the author typed.
    expect(link.textContent).toBe("ask#7754");
  });

  test("an ask#N absent from the channel stays plain text", async () => {
    mockIndexFetches([{ shortId: "ask#7754", id: CLOSED_ASK_UUID }]);

    const { container } = renderProse("See ask#999999.");

    await waitFor(() => expect(container.textContent).toContain("ask#999999"));
    expect(container.querySelector("a[href^='/ask/']")).toBeNull();
  });

  test("an asks-endpoint failure degrades to plain text rather than breaking the render", async () => {
    global.fetch = mock(async (url: string) => {
      if (url.startsWith("/api/asks/ids")) return jsonResponse({ error: "boom" }, false);
      if (url.startsWith("/api/tasks/ids")) return jsonResponse({ ids: [] });
      if (url.startsWith("/api/changesets")) return jsonResponse({ changesets: [] });
      return jsonResponse({ state: "ok", payload: {} });
    }) as unknown as typeof fetch;

    const { container } = renderProse("See ask#7754.");

    await waitFor(() => expect(container.textContent).toContain("ask#7754"));
    expect(container.querySelector("a[href^='/ask/']")).toBeNull();
  });
});
