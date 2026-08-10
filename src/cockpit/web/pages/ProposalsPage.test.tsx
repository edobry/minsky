/**
 * Component tests for ProposalsPage (mt#3331).
 *
 * Stubs global fetch with fixture /api/engprod/proposals responses and
 * asserts: run grouping + counters render, the healthy-empty vs errored
 * distinction (AT2), the unassigned-run bucket, and the accept/reject
 * mutation wiring (including the required-reason gate on reject).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProposalsPage } from "./ProposalsPage";
import type { EngprodProposalRow, EngprodRunSummary } from "../lib/engprod-proposals";

const originalFetch = globalThis.fetch;

interface StubCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(
  getResponse: () => { runs: EngprodRunSummary[]; proposals: EngprodProposalRow[] },
  postResponses: Record<string, unknown> = {}
): StubCall[] {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });

    if (method === "GET") {
      return new Response(JSON.stringify(getResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const key = Object.keys(postResponses).find((k) => url.includes(k));
    const response = key ? postResponses[key] : { ok: true, taskId: "mt#1", status: "TODO" };
    const status = (response as { __status?: number }).__status ?? 200;
    return new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProposalsPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

function run(overrides: Partial<EngprodRunSummary> = {}): EngprodRunSummary {
  return {
    id: "a7315e91-49e8-4313-a9a4-c0c8ecfd89bf",
    startedAt: "2026-07-31T06:46:37.267Z",
    finishedAt: "2026-07-31T06:47:23.464Z",
    turnsScanned: 61108,
    clustersFound: 12792,
    clustersSentToLlm: 10,
    proposalsGenerated: 5,
    suppressedByDedupe: 0,
    suppressedByBudget: 5,
    suppressedByMaximalCollapse: 11312,
    suppressedByLowDistinctiveness: 902,
    llmErrors: 0,
    errored: false,
    ...overrides,
  };
}

function proposal(overrides: Partial<EngprodProposalRow> = {}): EngprodProposalRow {
  return {
    taskId: "mt#3446",
    title: "EngProd proposal: deployment_status -> deployment_status (6x/6 sessions)",
    status: "BLOCKED",
    clusterSignature: "a8f4f3cc3e9fdcaa53538cbd",
    toolSequence: ["deployment_status", "deployment_status"],
    evidenceFrequency: 6,
    evidenceSessions: 6,
    evidenceChainLength: 2,
    score: 72,
    rejectionReason: null,
    createdAt: "2026-07-31T06:47:15.902Z",
    ...overrides,
  };
}

describe("ProposalsPage", () => {
  test("renders a run's counters and its ranked proposals", async () => {
    stubFetch(() => ({
      runs: [run()],
      proposals: [
        proposal({ taskId: "mt#3446", score: 72 }),
        proposal({ taskId: "mt#3447", score: 40, title: "EngProd proposal: git_pull -> git_log" }),
      ],
    }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("mt#3446")).toBeTruthy();
    });

    // Run-level counters (spec SC3) are visible.
    expect(screen.getByText(/61,108 turns scanned/)).toBeTruthy();
    expect(screen.getByText(/5 proposed/)).toBeTruthy();

    // Ranked: higher score (72) is #1, lower (40) is #2.
    const rows = screen.getAllByText(/^#\d$/);
    expect(rows[0]?.textContent).toBe("#1");
    expect(screen.getByText("mt#3447")).toBeTruthy();
  });

  test("a healthy run with zero proposals renders 'nothing found', distinct from an errored one (AT2)", async () => {
    stubFetch(() => ({
      runs: [run({ id: "healthy", proposalsGenerated: 0, errored: false, llmErrors: 0 })],
      proposals: [],
    }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("nothing found this run")).toBeTruthy();
    });
    expect(screen.queryByText("errored")).toBeNull();
  });

  test("an errored run (llmErrors > 0) renders an error badge, not the healthy-empty framing", async () => {
    stubFetch(() => ({
      runs: [run({ id: "errored-run", proposalsGenerated: 0, errored: true, llmErrors: 2 })],
      proposals: [],
    }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("errored")).toBeTruthy();
    });
    expect(screen.queryByText("nothing found this run")).toBeNull();
  });

  test("a proposal matching no run window renders under 'No matching run record'", async () => {
    stubFetch(() => ({
      runs: [run({ startedAt: "2026-07-31T06:46:37.267Z", finishedAt: "2026-07-31T06:47:23.464Z" })],
      proposals: [proposal({ taskId: "mt#3419", createdAt: "2026-07-31T01:29:30.288Z" })],
    }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("No matching run record")).toBeTruthy();
    });
    expect(screen.getByText("mt#3419")).toBeTruthy();
  });

  test("accept calls POST .../accept for the task", async () => {
    const calls = stubFetch(() => ({ runs: [run()], proposals: [proposal()] }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("mt#3446")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Accept mt#3446" }));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/accept"))).toBe(true);
    });
    const acceptCall = calls.find((c) => c.method === "POST" && c.url.includes("/accept"));
    expect(acceptCall?.url).toContain(encodeURIComponent("mt#3446"));
  });

  test("reject requires a non-empty reason before the confirm button is enabled, then posts it", async () => {
    const calls = stubFetch(() => ({ runs: [run()], proposals: [proposal()] }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText("mt#3446")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Reject mt#3446" }));

    // Once the dialog opens, Radix Dialog marks the rest of the page
    // aria-hidden (focus-trap/inert behavior) — so the ROW's own
    // "Reject mt#3446" button (still in the DOM, just now inaccessible)
    // drops out of the accessibility tree. The dialog's own confirm button
    // has no aria-label override (its accessible name is its plain "Reject"
    // text), so it's the only "Reject"-named match once the dialog is open.
    const textarea = await screen.findByPlaceholderText(/Why is this proposal being rejected/);
    const dialogConfirm = screen.getByRole("button", { name: "Reject" });
    expect(dialogConfirm.hasAttribute("disabled")).toBe(true);

    fireEvent.change(textarea, { target: { value: "duplicate of an existing tool" } });
    expect(dialogConfirm.hasAttribute("disabled")).toBe(false);

    fireEvent.click(dialogConfirm);

    await waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.includes("/reject"))).toBe(true);
    });
    const rejectCall = calls.find((c) => c.method === "POST" && c.url.includes("/reject"));
    expect(rejectCall?.body).toEqual({ reason: "duplicate of an existing tool" });
  });

  test("error state renders when the fetch fails", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 })) as unknown as typeof fetch;

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Failed to load EngProd proposals/)).toBeTruthy();
    });
  });
});
