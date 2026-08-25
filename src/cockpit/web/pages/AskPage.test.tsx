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
import { Glob } from "bun";
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
 * A terminal ask still shows what it asked (mt#4091).
 *
 * The originating report: the principal resolved ask#7754 by accident, opened
 * its deeplink, and could read the discussion thread but not the question —
 * "since the ask was resolved, I lose the context of what it was about." The
 * page was rendering a closure notice INSTEAD of the ask body, and showing the
 * recorded answer as `JSON.stringify` (`{"chosen": "hold"}` rather than the
 * option label "Hold off on production storage").
 *
 * Fixtures mirror the live shape of ask#7754.
 */
describe("terminal ask retains its body and reads its answer in operator language (mt#4091)", () => {
  /** The option ask#7754 was actually answered with. */
  const CHOSEN_LABEL = "Hold off on production storage";
  const OPTIONS = [
    { label: "Here's the key — go ahead", value: "approve", description: "You supply the key." },
    { label: CHOSEN_LABEL, value: "hold", description: "Nothing is created." },
  ];

  /**
   * Assert the chosen-marker badge sits on the option it names.
   *
   * A page-wide `getByText("chosen")` cannot distinguish the marker from a
   * payload key of the same name — which is precisely what this change removes,
   * so a test that could confuse the two is unable to witness a regression
   * (PR #2961 R1). Anchoring on the badge's own testid and then reading its
   * row's text ties the marker to the label instead.
   */
  function expectChosenBadgeOn(label: string): void {
    const badges = screen.getAllByTestId("ask-option-chosen");
    expect(badges.length).toBe(1);
    expect(badges[0]?.parentElement?.textContent).toContain(label);
  }
  const CONTEXT_REFS = [
    { kind: "task", ref: "mt#2680", description: "the blocked task" },
    { kind: "file", ref: "packages/domain/src/transcripts/store.ts" },
  ];

  function closedAsk(overrides: Partial<AskItem> = {}): AskItem {
    return makeAsk({
      state: "closed",
      question: "Should I create the production storage bucket?",
      options: OPTIONS,
      contextRefs: CONTEXT_REFS,
      respondedAt: "2026-08-13T12:00:00.000Z",
      closedAt: "2026-08-13T12:00:00.000Z",
      ...overrides,
    });
  }

  /** Stub the per-id endpoint; records every URL fetched so mounts are observable. */
  function stub(ask: AskItem): string[] {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/api/entity-thread/")) {
        return jsonResponse({
          localId: `entity-thread:ask:${ask.id}`,
          entityType: "ask",
          entityId: ask.id,
          live: false,
          blocks: [],
        });
      }
      if (url.includes(`/api/asks/${ask.id}`)) return jsonResponse({ ask });
      return jsonResponse({ error: "unexpected" }, 500);
    }) as unknown as typeof globalThis.fetch;
    return urls;
  }

  test("AT1: the question, every option with its description, and the contextRefs all render", async () => {
    const ask = closedAsk({
      response: { responder: "operator", payload: { chosen: "hold", option: "hold" } },
    });
    stub(ask);
    renderAskPage(ask.id);

    await waitFor(() => {
      expect(screen.getByText(/Should I create the production storage bucket/)).toBeDefined();
    });
    for (const opt of OPTIONS) {
      // getAll, not get: the chosen option's label and description appear twice
      // on the page by design — once in the notice as the answer of record, and
      // once in the options list as part of the question of record.
      expect(screen.getAllByText(opt.label).length).toBeGreaterThan(0);
      expect(screen.getAllByText(new RegExp(opt.description)).length).toBeGreaterThan(0);
    }
    for (const ref of CONTEXT_REFS) {
      expect(screen.getByText(ref.ref)).toBeDefined();
    }
  });

  test("AT6: the terminal branch renders AskDetail itself, not an inlined copy of the body", async () => {
    // "From:" and "Age:" are AskDetail's own metadata labels — an inlined body
    // in AskPage would satisfy AT1 while failing this.
    const ask = closedAsk({ response: { responder: "operator", payload: { chosen: "hold" } } });
    stub(ask);
    renderAskPage(ask.id);

    await waitFor(() => expect(screen.getByText("From:")).toBeDefined());
    expect(screen.getByText("Age:")).toBeDefined();
  });

  test("AT2: the chosen option renders as its LABEL, with no JSON dump", async () => {
    const ask = closedAsk({
      response: { responder: "operator", payload: { chosen: "hold", option: "hold" } },
    });
    stub(ask);
    renderAskPage(ask.id);

    await waitFor(() => {
      expect(screen.getAllByText(CHOSEN_LABEL).length).toBeGreaterThan(0);
    });
    expectChosenBadgeOn(CHOSEN_LABEL);
    expect(screen.queryByText(/Raw response record/)).toBeNull();
    expect(screen.queryByText(/"chosen":/)).toBeNull();
  });

  test("AT2a: an option stored without a `value` still resolves by label (mt#3181 path)", async () => {
    const ask = closedAsk({
      // No `value` — the shape of ask#5769, the ONE stored ask predating
      // `askOptionSchema`'s normalization (measured 2026-08-13: 1 of 183 asks
      // carrying options). `AskOption.value` is REQUIRED on purpose, so a
      // fixture for that row has to step outside the type; the cast is
      // deliberate, not a workaround. See the field's comment in
      // `../widgets/AskDetail.tsx`.
      options: [
        { label: "Approve the rotation" },
        { label: CHOSEN_LABEL },
      ] as unknown as AskItem["options"],
      response: {
        responder: "operator",
        payload: { chosen: CHOSEN_LABEL, option: CHOSEN_LABEL },
      },
    });
    stub(ask);
    renderAskPage(ask.id);

    await waitFor(() => expect(screen.getAllByTestId("ask-option-chosen").length).toBe(1));
    expectChosenBadgeOn(CHOSEN_LABEL);
    expect(screen.queryByText(/Raw response record/)).toBeNull();
  });

  test("AT2b: an optionless approval reads as Approved", async () => {
    const ask = closedAsk({
      kind: "authorization.approve",
      options: undefined,
      response: { responder: "operator", payload: { approved: true } },
    });
    stub(ask);
    renderAskPage(ask.id);

    await waitFor(() => expect(screen.getByText("Approved")).toBeDefined());
    expect(screen.queryByText(/Raw response record/)).toBeNull();
  });

  test("AT2b: a free-text disposition renders as prose", async () => {
    const ask = closedAsk({
      response: { responder: "operator", payload: { message: "Answered in conversation." } },
    });
    stub(ask);
    renderAskPage(ask.id);

    await waitFor(() => expect(screen.getByText(/Answered in conversation/)).toBeDefined());
    expect(screen.queryByText(/Raw response record/)).toBeNull();
    // The message text alone does NOT discriminate: the pre-mt#4091 page dumped
    // the whole payload, so `/Answered in conversation/` matched INSIDE the JSON
    // and this was the one case the negative control could not fail. Asserting
    // the JSON key is absent is what makes the probe capable of failing.
    expect(screen.queryByText(/"message":/)).toBeNull();
  });

  test("AT2b: a policy resolution says so, and is NOT presented as unanswered", async () => {
    const ask = closedAsk({
      response: { responder: "policy", payload: { citation: "commit-auth standing grant" } },
    });
    stub(ask);
    renderAskPage(ask.id);

    await waitFor(() => expect(screen.getByText("Resolved by policy")).toBeDefined());
    expect(screen.getByText(/commit-auth standing grant/)).toBeDefined();
    // `isAutomatedClosureResponder` excludes `policy` deliberately — a covering
    // policy is a real answer, so the mt#3215 language must NOT appear here.
    expect(screen.queryByText(/NOT answered by an operator/)).toBeNull();
  });

  test("AT2b: an unrecognized payload shape is labelled as the raw record", async () => {
    const ask = closedAsk({
      response: { responder: "operator", payload: { somethingNew: 42 } },
    });
    stub(ask);
    renderAskPage(ask.id);

    await waitFor(() => expect(screen.getByText(/Raw response record/)).toBeDefined());
  });

  test("AT4: no resolve, defer or escalate control is offered on a terminal ask", async () => {
    const ask = closedAsk({
      response: { responder: "operator", payload: { chosen: "hold" } },
    });
    stub(ask);
    renderAskPage(ask.id);

    await waitFor(() => expect(screen.getByText("From:")).toBeDefined());
    expect(screen.queryByRole("button", { name: /defer/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /escalate/i })).toBeNull();
    for (const opt of OPTIONS) {
      expect(screen.queryByRole("button", { name: new RegExp(opt.label) })).toBeNull();
    }
  });

  test("AT5: the discussion thread still mounts for a terminal ask (mt#3365 unchanged)", async () => {
    const ask = closedAsk({
      response: { responder: "operator", payload: { chosen: "hold" } },
    });
    const urls = stub(ask);
    renderAskPage(ask.id);

    await waitFor(() => expect(screen.getByText("From:")).toBeDefined());
    await waitFor(() => {
      expect(urls.some((url) => url.includes(`/api/entity-thread/`))).toBe(true);
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
 * This block reproduces the actual failure mode instead of re-testing rendered output. It scans
 * the cockpit-web tree for every file importing `isAutomatedClosureResponder`, extracts each
 * one's specifier from source (so the check tracks what the code actually imports, not a
 * hardcoded assumption), then dynamically imports THAT specifier in a freshly spawned Bun
 * subprocess with `globalThis.process` deleted before the import runs — the closest simulation
 * of a real browser's absence of `process` available without a full browser/jsdom harness.
 *
 * The scan is tree-wide rather than pinned to AskPage.tsx because the import MOVED (mt#4091):
 * the closure phrasing now lives in `components/TerminalAskNotice.tsx`, and a guard pinned to
 * one path would have thrown its "update this test's extraction regex" error on a change that
 * was in no way a browser-safety regression. Scanning for the SYMBOL survives the next move and
 * covers any additional importer that appears — which a path-pinned guard would silently miss.
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
describe("cockpit-web import-chain browser safety (mt#3239)", () => {
  const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));

  interface ImportSite {
    /** Absolute path of the importing file, used to resolve a relative specifier. */
    file: string;
    specifier: string;
  }

  /** Every cockpit-web source file importing `isAutomatedClosureResponder`. */
  function findImportSites(): ImportSite[] {
    const sites: ImportSite[] = [];
    for (const relative of new Glob("**/*.{ts,tsx}").scanSync(WEB_ROOT)) {
      // Test files are excluded so this guard cannot match its own regex literal.
      if (/\.test\.tsx?$/.test(relative)) continue;
      const file = `${WEB_ROOT}${relative}`;
      const match = readFileSync(file, "utf8").match(
        /import\s*\{\s*isAutomatedClosureResponder\s*\}\s*from\s*["']([^"']+)["']/
      );
      if (match?.[1]) sites.push({ file, specifier: match[1] });
    }
    return sites;
  }

  /** Import `specifier` in a fresh Bun subprocess with `process` deleted first. */
  async function importsWithoutProcess(
    specifier: string,
    importer: string = fileURLToPath(new URL("./AskPage.tsx", import.meta.url))
  ): Promise<{ exitCode: number; stderr: string }> {
    const resolvedSpecifier = specifier.startsWith(".")
      ? fileURLToPath(new URL(specifier, `file://${importer}`))
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

  test("at least one cockpit-web file imports isAutomatedClosureResponder (the scan has teeth)", () => {
    // Without this, a rename of the symbol would turn the check below into a
    // vacuous pass over an empty list — green, and testing nothing.
    expect(findImportSites().length).toBeGreaterThan(0);
  });

  test("every module cockpit-web imports isAutomatedClosureResponder from has no Node dependency", async () => {
    for (const site of findImportSites()) {
      const { exitCode, stderr } = await importsWithoutProcess(site.specifier, site.file);
      expect(
        exitCode,
        `${site.file} imports isAutomatedClosureResponder from "${site.specifier}", which ` +
          `crashes when \`process\` is undefined (the browser condition that broke the cockpit ` +
          `ask page, mt#3239):\n${stderr}`
      ).toBe(0);
    }
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

describe("mt#4503: a failed resolve keeps the ask on screen and says why", () => {
  const ID = "0147caa5-e208-4fac-9b1c-0479787a9a26";

  /**
   * Stub the page's fetches with a resolve endpoint that answers `status`.
   *
   * The endpoint's real failure modes are 403 (not operator-routed), 404, 409
   * (concurrent transition), 500 and 503 (persistence down) — every one of them
   * used to reach the same `onSettled` handler as a success, so the tab closed
   * and the operator was navigated to /asks as though their answer had been
   * recorded. Only the ask's server-side state disagreed.
   */
  function stubResolve(status: number, body: unknown): void {
    const ask = makeAsk({
      id: ID,
      state: "suspended",
      options: [
        { label: "Run it", value: "run" },
        { label: "Hold off", value: "hold" },
      ],
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/resolve")) return jsonResponse(body, status);
      if (url.includes(`/api/asks/${ID}`)) return jsonResponse({ ask });
      if (url.endsWith("/api/asks")) return jsonResponse({ asks: [], total: 0 });
      return jsonResponse({ state: "degraded" });
    }) as unknown as typeof globalThis.fetch;
  }

  test("a 409 leaves the ask rendered — no tab close, no navigation away", async () => {
    stubResolve(409, { error: 'respondAndCloseAsk: Ask is in "closed" state' });
    renderAskPage(ID);

    const button = await screen.findByRole("button", { name: /Run it/ });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId("ask-action-error")).toBeTruthy());

    // The load-bearing assertion. `settle()` closes this tab with
    // `navigateTo: "/asks"`, and the router here mounts only `/ask/:id` — so if
    // the failure had still triggered it, this title would be gone.
    expect(screen.getByText("Calibration-review disposition")).toBeTruthy();

    const error = screen.getByTestId("ask-action-error");
    expect(error.textContent).toContain("Your response was not saved");
    expect(error.textContent).toContain("409");

    // And the operator can try again: a failed attempt must not leave the ask
    // permanently unanswerable.
    expect((screen.getByRole("button", { name: /Run it/ }) as HTMLButtonElement).disabled).toBe(
      false
    );
  });

  test("a 503 is distinguishable from a 409 — the operator sees which one happened", async () => {
    // Same silent path before mt#4503, but opposite remedies: a 409 means
    // someone else answered it, a 503 means the store is down and retrying later
    // is the move. Collapsing both into "the tab closed" told the operator
    // neither.
    stubResolve(503, { error: "Ask repository unavailable" });
    renderAskPage(ID);

    fireEvent.click(await screen.findByRole("button", { name: /Run it/ }));

    await waitFor(() => expect(screen.getByTestId("ask-action-error")).toBeTruthy());
    expect(screen.getByTestId("ask-action-error").textContent).toContain("503");
  });

  test("the success path still settles — the operator lands on /asks", async () => {
    stubResolve(200, { ok: true });

    // A local render that MOUNTS `/asks`, so the assertion is that we ARRIVED
    // there rather than that the detail body went away. Waiting on a
    // disappearance is what made the first version of this test load-sensitive:
    // `queryByText(...) === null` is already true during the re-render the
    // navigation causes, so the polling `waitFor` was racing the tab machinery
    // instead of observing it. `findBy*` on the destination has one settling
    // condition and no race.
    render(
      <MemoryRouter initialEntries={[`/ask/${ID}`]}>
        <QueryClientProvider client={createTestQueryClient()}>
          <TabsProvider>
            <Routes>
              <Route path="/ask/:id" element={<AskPage />} />
              <Route path="/asks" element={<div>THE ASKS LIST</div>} />
            </Routes>
          </TabsProvider>
        </QueryClientProvider>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("button", { name: /Run it/ }));

    // The regression guard on moving the handler off `onSettled`: success must
    // still close the tab and navigate.
    expect(await screen.findByText("THE ASKS LIST")).toBeTruthy();
    expect(screen.queryByTestId("ask-action-error")).toBeNull();
  });
});
