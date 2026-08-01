/**
 * AskPage tests (mt#2669).
 *
 * The deeplink-resolution contract: the page resolves the ask by a dedicated
 * per-id fetch (seeded from the pending-list cache when present), and never
 * renders a terminal-sounding verdict for an ask the server would return.
 *
 *   - Live ask absent from the list cache: per-id fetch renders detail
 *     (the 2026-07-08 fresh-cockpit-boot deeplink repro).
 *   - Terminal ask: state-specific message with the recorded response,
 *     not the old generic "no longer pending".
 *   - Unknown id: "not found" only after the per-id fetch settles.
 *   - Seeded cache: a live ask already in the list cache renders immediately.
 *   - Responded ask: NOT terminal per the domain state machine — renders the
 *     actionable detail view, not a banner (PR #1848 R1 regression).
 *
 * Run via:
 *   bun test --preload ./tests/dom-setup.ts src/cockpit/web/pages/AskPage.test.tsx
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AskPage } from "./AskPage";
import { TabsProvider } from "../lib/tabs";
import type { AskItem } from "../widgets/AskDetail";
import { RESOLVE_PROPOSAL_FENCE } from "../lib/resolve-proposal";
import { RESOLVE_PROPOSAL_SURFACE } from "../components/ResolveProposalCard";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function makeAsk(overrides: Partial<AskItem> = {}): AskItem {
  return {
    id: "0147caa5-e208-4fac-9b1c-0479787a9a24",
    kind: "direction.decide",
    state: "suspended",
    title: "Calibration-review disposition",
    question: "Which disposition should the calibration review take?",
    requestor: "agent",
    routingTarget: "operator",
    createdAt: "2026-07-08T03:18:00.000Z",
    suspendedAt: "2026-07-08T03:18:05.000Z",
    windowMissedCount: 0,
    metadata: {},
    ...overrides,
  };
}

function renderAskPage(askId: string, queryClient = createTestQueryClient()) {
  return render(
    <MemoryRouter initialEntries={[`/ask/${askId}`]}>
      <QueryClientProvider client={queryClient}>
        <TabsProvider>
          <Routes>
            <Route path="/ask/:id" element={<AskPage />} />
          </Routes>
        </TabsProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("AskPage deeplink resolution (mt#2669)", () => {
  test("live ask absent from the list cache renders detail via per-id fetch", async () => {
    const ask = makeAsk();
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/asks/${ask.id}`)) return jsonResponse({ ask });
      if (url.endsWith("/api/asks")) return jsonResponse({ asks: [], total: 0 });
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage(ask.id);

    await waitFor(() => {
      expect(screen.getByText("Calibration-review disposition")).toBeDefined();
    });
    expect(screen.queryByText(/no longer pending/i)).toBeNull();
  });

  test("terminal ask renders a state-specific message with the recorded response", async () => {
    const ask = makeAsk({
      state: "closed",
      response: { responder: "operator", payload: { option: "flip" } },
      respondedAt: "2026-07-08T05:00:00.000Z",
      closedAt: "2026-07-08T05:00:00.000Z",
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/asks/${ask.id}`)) return jsonResponse({ ask });
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage(ask.id);

    await waitFor(() => {
      expect(screen.getByText(/This ask was resolved/)).toBeDefined();
    });
    expect(screen.getByText(/by operator/)).toBeDefined();
    expect(screen.queryByText(/no longer pending/i)).toBeNull();
  });

  test("an auto-closed ask (mt#3215) renders as NOT answered, distinct from an operator response", async () => {
    const ask = makeAsk({
      state: "closed",
      response: {
        responder: "system:parent-task-terminal",
        payload: { sweep: "stale-suspended-close", task: "mt#3001", parentTaskId: "mt#3210" },
      },
      respondedAt: "2026-07-25T18:21:25.000Z",
      closedAt: "2026-07-25T18:21:25.000Z",
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/asks/${ask.id}`)) return jsonResponse({ ask });
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage(ask.id);

    await waitFor(() => {
      expect(screen.getByText(/auto-closed by the system/)).toBeDefined();
    });
    expect(screen.getByText(/NOT answered by an operator/)).toBeDefined();
    expect(screen.getByText(/Auto-closed by system:parent-task-terminal/)).toBeDefined();
    expect(screen.queryByText(/^This ask was resolved\.?$/)).toBeNull();
  });

  test("expired ask names the expiry, not a generic message", async () => {
    const ask = makeAsk({ state: "expired" });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/asks/${ask.id}`)) return jsonResponse({ ask });
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage(ask.id);

    await waitFor(() => {
      expect(screen.getByText(/This ask was expired/)).toBeDefined();
    });
  });

  test("responded ask is NOT terminal — renders the detail view, not a banner (PR #1848 R1)", async () => {
    const ask = makeAsk({
      state: "responded",
      response: { responder: "operator", payload: { option: "flip" } },
      respondedAt: "2026-07-08T05:00:00.000Z",
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/asks/${ask.id}`)) return jsonResponse({ ask });
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage(ask.id);

    await waitFor(() => {
      expect(screen.getByText("Calibration-review disposition")).toBeDefined();
    });
    expect(screen.queryByText(/This ask was/)).toBeNull();
  });

  test("unknown id renders not-found only after the per-id fetch settles", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/asks/")) return jsonResponse({ error: "Ask not found" }, 404);
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage("00000000-0000-0000-0000-000000000000");

    await waitFor(() => {
      expect(screen.getByText(/No ask with this id was found/)).toBeDefined();
    });
    expect(screen.queryByText(/no longer pending/i)).toBeNull();
  });

  test("live ask already in the list cache renders immediately (seeded initialData)", async () => {
    const ask = makeAsk();
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["asks"], { asks: [ask], total: 1 });

    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/api/asks/${ask.id}`)) return jsonResponse({ ask });
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;

    renderAskPage(ask.id, queryClient);

    await waitFor(() => {
      expect(screen.getByText("Calibration-review disposition")).toBeDefined();
    });
  });
});

/**
 * Browser-safety regression guard (mt#3239).
 *
 * mt#3215 (PR #2315) added `import { isAutomatedClosureResponder } from
 * "@minsky/domain/ask/close-as-resolved"` to this page. That module transitively imports
 * `@minsky/shared/logger`, which reads `process.env.*` at its top level — a Node global with no
 * browser equivalent — so the cockpit ask page crashed on load with `Can't find variable:
 * process`. Nothing in the tests ABOVE caught this: they pass under Bun, where `process` IS
 * defined, so importing the Node-dependent chain never throws in that environment.
 *
 * This block reproduces the actual failure mode instead of re-testing rendered output. It
 * extracts the import specifier this file currently uses for `isAutomatedClosureResponder` (by
 * reading its own source — so the check tracks whatever AskPage.tsx actually imports, not a
 * hardcoded assumption), then dynamically imports THAT specifier in a freshly spawned Bun
 * subprocess with `globalThis.process` deleted before the import runs — the closest simulation
 * of a real browser's absence of `process` available without a full browser/jsdom harness.
 *
 * Subprocess isolation is deliberate, not incidental: bunfig.toml runs this file with
 * `randomize = true` test-file ordering, and a same-process `delete globalThis.process` followed
 * by a dynamic `import()` is a no-op once ANY earlier-run file in the same invocation has already
 * imported the same module specifier — ES module bodies evaluate once per process and are cached
 * by resolved specifier, so re-importing (even with `process` deleted) just returns the
 * already-evaluated, already-cached export without re-running any top-level code. A fresh
 * subprocess has an empty module cache, so this check is independent of suite ordering.
 *
 * Coverage note: this targets the SPECIFIC import this incident was about
 * (`isAutomatedClosureResponder`), not every import in AskPage.tsx — importing the whole
 * `AskPage.tsx` module directly via a bare `bun -e` subprocess (verified during authoring, not
 * kept as a test) fails for an UNRELATED reason: react-router-dom/@tanstack/react-query resolve
 * to Node-targeted builds outside a real bundler's "browser" export conditions, which Vite's
 * production build does not hit. That mismatch is a test-environment artifact, not a real
 * regression, which is why "verify in a real browser" (this task's PR body) is the higher-fidelity
 * check for the whole-page question and this subprocess check is scoped to the one import mt#3239
 * actually fixed.
 */
describe("AskPage import-chain browser safety (mt#3239)", () => {
  const ASK_PAGE_PATH = fileURLToPath(new URL("./AskPage.tsx", import.meta.url));
  const ASK_PAGE_SOURCE = readFileSync(ASK_PAGE_PATH, "utf8");

  function extractIsAutomatedClosureResponderSpecifier(): string {
    const match = ASK_PAGE_SOURCE.match(
      /import\s*\{\s*isAutomatedClosureResponder\s*\}\s*from\s*["']([^"']+)["']/
    );
    const specifier = match?.[1];
    if (!specifier) {
      throw new Error(
        "AskPage.tsx no longer imports isAutomatedClosureResponder by this exact pattern -- " +
          "update this test's extraction regex to match the current import shape."
      );
    }
    return specifier;
  }

  /** Import `specifier` in a fresh Bun subprocess with `process` deleted first. */
  async function importsWithoutProcess(specifier: string): Promise<{ exitCode: number; stderr: string }> {
    const resolvedSpecifier = specifier.startsWith(".")
      ? fileURLToPath(new URL(specifier, `file://${ASK_PAGE_PATH}`))
      : specifier;
    const script = `delete globalThis.process; await import(${JSON.stringify(resolvedSpecifier)});`;
    // process.execPath (not a bare "bun") guarantees the subprocess is the SAME Bun binary
    // running this suite, not whatever "bun" resolves to on PATH (which can differ in CI or a
    // multi-version dev machine). NOTE: `Bun.execPath` is NOT a real Bun API (verified against
    // Bun v1.2.21 -- `Bun.execPath` is `undefined`, calling it throws "not a function"); the
    // correct binary path is `process.execPath`, the Node-compat property Bun implements. This
    // spawn call runs in the PARENT process, where `process` is still fully intact -- only the
    // CHILD script (the `-e` argument below) deletes `globalThis.process`, so resolving the
    // binary here doesn't conflict with what the test is proving.
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      stderr: "pipe",
      stdout: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    return { exitCode, stderr };
  }

  test("the module AskPage.tsx currently imports isAutomatedClosureResponder from has no Node dependency", async () => {
    const specifier = extractIsAutomatedClosureResponderSpecifier();
    const { exitCode, stderr } = await importsWithoutProcess(specifier);
    expect(
      exitCode,
      `AskPage.tsx imports isAutomatedClosureResponder from "${specifier}", which crashes when ` +
        `\`process\` is undefined (the browser condition that broke the cockpit ask page, ` +
        `mt#3239):\n${stderr}`
    ).toBe(0);
  });

  test("regression guard: the pre-mt#3239 Node import path DOES crash without `process` (proves the check above has teeth)", async () => {
    const { exitCode } = await importsWithoutProcess("@minsky/domain/ask/close-as-resolved");
    expect(exitCode).not.toBe(0);
  });
});

describe("AskPage thread resolve proposal wiring (mt#3368)", () => {
  // These WERE source-level guards, written because a behavioral render test
  // appeared impossible — AskPage seemed to blank whenever its thread had
  // turns. That premise was wrong (mt#3452): the blank came from an invalid
  // `state: "pending"` in the FIXTURE, not from thread turns. `pending` is not
  // an AskState; the real set is detected/classified/routed/suspended/
  // responded/closed/cancelled/expired.
  //
  // The behavioral test now lives below and asserts the same property by
  // actually clicking confirm, so only the one guard the render test cannot
  // cover is kept: the terminal-ask gating, which is an ABSENCE (no slot is
  // supplied) and so has no rendered artifact to assert against.
  const source = readFileSync(
    fileURLToPath(new URL("./AskPage.tsx", import.meta.url)),
    "utf8"
  );

  test("the proposal slot is withheld from a terminal ask", () => {
    // A resolved ask has nothing left to confirm; offering the control there
    // invites a second write to a closed record.
    expect(source).toMatch(/terminal\s*\n?\s*\?\s*\{\}/);
    expect(source).toContain("proposalSlot:");
  });
});

describe("AskPage renders with an entity thread (mt#3452)", () => {
  const ID = "0147caa5-e208-4fac-9b1c-0479787a9a24";

  function stubWithThread(blocks: unknown[]): void {
    const ask = makeAsk({ id: ID });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/entity-thread/")) {
        return jsonResponse({
          localId: `entity-thread:ask:${ID}`,
          entityType: "ask",
          entityId: ID,
          live: false,
          blocks,
        });
      }
      if (url.includes(`/api/asks/${ID}`)) return jsonResponse({ ask });
      return jsonResponse({ state: "degraded" });
    }) as unknown as typeof globalThis.fetch;
  }

  test("renders with an EMPTY thread (control)", async () => {
    stubWithThread([]);
    renderAskPage(ID);
    await waitFor(() => {
      expect(screen.getByText("Calibration-review disposition")).toBeDefined();
    });
  });

  test("renders with ONE agent turn in the thread", async () => {
    stubWithThread([
      {
        id: "t#1",
        type: "assistant-text",
        source: "observed",
        content: "hello",
        timestamp: "2026-07-31T06:00:00.000Z",
        rawJsonlType: "assistant",
      },
    ]);
    renderAskPage(ID);
    await waitFor(() => {
      expect(screen.getByText("Calibration-review disposition")).toBeDefined();
    });
  });
});

describe("mt#3368 behavioral: the payload SENT equals the payload DISPLAYED", () => {
  const ID = "0147caa5-e208-4fac-9b1c-0479787a9a25";

  function stub(letter: string, captured: unknown[]): void {
    const ask = makeAsk({
      id: ID,
      state: "routed",
      // `value` is required on AskOption — omitting it is the same class of
      // invalid-fixture mistake that produced mt#3452's false premise.
      options: [
        { label: "Run it", value: "run" },
        { label: "Hold off", value: "hold" },
      ],
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/resolve")) {
        captured.push(JSON.parse(String(init?.body)));
        return jsonResponse({ ok: true });
      }
      if (url.includes("/api/entity-thread/")) {
        return jsonResponse({
          localId: `entity-thread:ask:${ID}`,
          entityType: "ask",
          entityId: ID,
          live: false,
          blocks: [
            {
              id: "t#1",
              type: "assistant-text",
              source: "observed",
              content:
                "Hold off.\n\n```" +
                RESOLVE_PROPOSAL_FENCE +
                '\n{"optionLetter": "' +
                letter +
                '", "rationale": "the branch is stale"}\n```',
              timestamp: "2026-07-31T06:00:00.000Z",
              rawJsonlType: "assistant",
            },
          ],
        });
      }
      if (url.includes(`/api/asks/${ID}`)) return jsonResponse({ ask });
      return jsonResponse({ state: "degraded" });
    }) as unknown as typeof globalThis.fetch;
  }

  test("confirm sends exactly what the card rendered", async () => {
    const captured: unknown[] = [];
    stub("B", captured);
    renderAskPage(ID);

    const confirm = await screen.findByRole("button", { name: /confirm and answer/i });
    // Rendering a proposal must not resolve anything.
    expect(captured).toEqual([]);

    const displayed = screen.getByLabelText("Proposed resolve payload").textContent;
    fireEvent.click(confirm);

    await waitFor(() => expect(captured.length).toBe(1));
    expect(JSON.stringify(captured[0], null, 2)).toBe(displayed);

    // Equality alone is NOT sufficient (PR #2524 R1 BLOCKING): if the card
    // rendered `resolvedIn: "inbox"` AND the mutation sent "inbox", the
    // assertion above still passes while the thread/inbox distinction is
    // silently lost. The deleted source-guard pinned that surface; this pins it
    // behaviorally, on the payload actually POSTed.
    const sent = captured[0] as { attentionCost?: { resolvedIn?: string } };
    expect(sent.attentionCost?.resolvedIn).toBe(RESOLVE_PROPOSAL_SURFACE);
    expect(sent.attentionCost?.resolvedIn).not.toBe("inbox");
  });
});
