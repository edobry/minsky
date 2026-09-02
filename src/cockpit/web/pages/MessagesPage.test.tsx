/**
 * MessagesPage tests (mt#4874).
 *
 * The cases that matter here are the ones where the page must NOT render a
 * plausible-looking nothing:
 *
 * - a live query failure must be visibly an error, never an empty feed (this
 *   corner of the cockpit rendered healthy zeros for five weeks while every
 *   query under it threw — mt#2076 / mt#2757);
 * - an empty feed must still state its coverage limits, because an operator
 *   looking at one is exactly the person who cannot tell "no traffic" from "no
 *   coverage";
 * - an unpaired send must read as "no delivery record found" and must not be
 *   totalled into an undelivered count.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { MessagesPage } from "./MessagesPage";
import type { MessagesPayload } from "../../widgets/messages";
import type { PeerMessageFeedEntry } from "@minsky/domain/transcripts/peer-message-correlation";

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

function mockWidgetData(
  response: { state: "ok"; payload: MessagesPayload } | { state: "degraded"; reason: string }
) {
  global.fetch = (async (url: string) => {
    if (String(url).startsWith("/api/widget/messages/data")) {
      return { ok: true, json: async () => response } as Response;
    }
    // Every other request (the entity-label index EntityRef consults) resolves
    // to an empty, well-formed body so a miss degrades rather than throws.
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <MessagesPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const COVERAGE = {
  peerTurns: 0,
  envelopesRead: 0,
  envelopesMissing: 0,
  sendsRead: 0,
  senderScanLimit: 500,
  senderScanTruncated: false,
};

function sentEntry(overrides: Partial<PeerMessageFeedEntry> = {}): PeerMessageFeedEntry {
  return {
    key: "sent:sender:7:0",
    direction: "sent",
    at: "2026-09-01T12:00:10.000Z",
    agentSessionId: "11111111-1111-4111-8111-111111111111",
    body: "please pick up mt#4874",
    recipient: "agent-7",
    origin: null,
    fromKind: null,
    correlation: { state: "paired", counterpartKey: "received:receiver:412" },
    ...overrides,
  };
}

function receivedEntry(overrides: Partial<PeerMessageFeedEntry> = {}): PeerMessageFeedEntry {
  return {
    key: "received:receiver:412",
    direction: "received",
    at: "2026-09-01T12:00:12.000Z",
    agentSessionId: "22222222-2222-4222-8222-222222222222",
    body: "please pick up mt#4874",
    recipient: null,
    origin: {
      from: "uds:/tmp/cc-socks/16603.sock",
      fromKind: "session",
      peerPid: 16603,
      msgId: "e4f53555-0000-4000-8000-000000000000",
      name: "minsky-64",
      fromMode: "prompting",
      senderTaskId: null,
      hopChain: null,
      body: "please pick up mt#4874",
    },
    fromKind: "session",
    correlation: { state: "paired", counterpartKey: "sent:sender:7:0" },
    ...overrides,
  };
}

function okPayload(entries: PeerMessageFeedEntry[], coverage = COVERAGE): MessagesPayload {
  return {
    status: "ok",
    coverage: { ...coverage, sendsRead: entries.filter((e) => e.direction === "sent").length },
    feed: {
      entries,
      counts: {
        sent: entries.filter((e) => e.direction === "sent").length,
        received: entries.filter((e) => e.direction === "received").length,
        paired: entries.filter((e) => e.correlation.state === "paired").length,
        ambiguous: entries.filter((e) => e.correlation.state === "ambiguous").length,
        sentUnmatched: entries.filter(
          (e) => e.direction === "sent" && e.correlation.state === "unmatched"
        ).length,
        receivedUnmatched: entries.filter(
          (e) => e.direction === "received" && e.correlation.state === "unmatched"
        ).length,
      },
    },
  };
}

describe("MessagesPage — states that must not look like each other", () => {
  test("a live query failure renders an error, never an empty feed", async () => {
    mockWidgetData({ state: "degraded", reason: "the database connection failed mid-request." });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("messages-error")).toBeDefined());
    expect(screen.getByText("Data unavailable")).toBeDefined();
    expect(screen.getByTestId("messages-error").textContent).toContain("database connection failed");
    // Not the empty state, and not a feed with zero rows.
    expect(screen.queryByTestId("messages-empty")).toBeNull();
    expect(screen.queryByTestId("messages-feed")).toBeNull();
  });

  test("an empty corpus renders a deliberate empty state AND its coverage limits", async () => {
    mockWidgetData({ state: "ok", payload: { status: "no-data", coverage: COVERAGE } });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("messages-empty")).toBeDefined());
    expect(screen.getByText("No cross-session messages in this project")).toBeDefined();
    // SC10 — the limits are on the page in the empty state too.
    expect(screen.getByTestId("messages-coverage")).toBeDefined();
    expect(screen.getByTestId("messages-coverage").textContent).toContain(
      "Local transcripts only"
    );
    expect(screen.queryByTestId("messages-error")).toBeNull();
  });
});

describe("MessagesPage — the feed", () => {
  test("renders a correlated pair, one row each, with both directions labelled", async () => {
    mockWidgetData({ state: "ok", payload: okPayload([sentEntry(), receivedEntry()]) });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("messages-feed")).toBeDefined());
    expect(screen.getByTestId("messages-row-sent:sender:7:0")).toBeDefined();
    expect(screen.getByTestId("messages-row-received:receiver:412")).toBeDefined();
    expect(screen.getByTestId("messages-direction-sent")).toBeDefined();
    expect(screen.getByTestId("messages-direction-received")).toBeDefined();
    expect(screen.getAllByTestId("messages-correlation-paired")).toHaveLength(2);
  });

  test("a session peer and an in-session agent are visually distinguished (SC8)", async () => {
    const agentPeer = receivedEntry({
      key: "received:receiver:500",
      fromKind: "agent",
      origin: {
        from: "implementer",
        fromKind: "agent",
        peerPid: null,
        msgId: null,
        name: "implementer",
        fromMode: null,
        senderTaskId: "mt#4874",
        hopChain: null,
        body: "on it",
      },
      body: "on it",
      correlation: { state: "unmatched" },
    });
    mockWidgetData({ state: "ok", payload: okPayload([receivedEntry(), agentPeer]) });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("messages-feed")).toBeDefined());
    expect(screen.getByTestId("messages-peer-kind-session")).toBeDefined();
    expect(screen.getByTestId("messages-peer-kind-agent")).toBeDefined();
  });

  test("an unpaired send reads as 'no delivery record found' and is not totalled as undelivered", async () => {
    const unmatched = sentEntry({ correlation: { state: "unmatched" } });
    mockWidgetData({ state: "ok", payload: okPayload([unmatched]) });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("messages-feed")).toBeDefined());
    expect(screen.getByTestId("messages-correlation-unmatched").textContent).toBe(
      "no delivery record found"
    );
    expect(screen.getByTestId("messages-counts").textContent).toContain(
      "1 sends with no delivery record"
    );
    // The words this page must never use about an unpaired send.
    const page = screen.getByTestId("messages-page").textContent ?? "";
    expect(page.toLowerCase()).not.toContain("undelivered");
    expect(page.toLowerCase()).not.toContain("lost");
    expect(page.toLowerCase()).not.toContain("failed to deliver");
  });

  test("an ambiguous pairing says so and names the candidate count, rather than picking one", async () => {
    const ambiguous = receivedEntry({
      correlation: { state: "ambiguous", candidateCount: 2 },
    });
    mockWidgetData({ state: "ok", payload: okPayload([ambiguous]) });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("messages-feed")).toBeDefined());
    expect(screen.getByTestId("messages-correlation-ambiguous").textContent).toContain(
      "2 identical candidates"
    );
  });

  test("receiver-side facts are displayed, and the row survives their absence", async () => {
    mockWidgetData({ state: "ok", payload: okPayload([receivedEntry()]) });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("messages-origin-facts")).toBeDefined());
    const facts = screen.getByTestId("messages-origin-facts").textContent ?? "";
    expect(facts).toContain("pid: 16603");
    expect(facts).toContain("msg_id: e4f53555");

    cleanup();
    const bare = receivedEntry({
      origin: {
        from: "uds:/tmp/cc-socks/1.sock",
        fromKind: "session",
        peerPid: null,
        msgId: null,
        name: null,
        fromMode: null,
        senderTaskId: null,
        hopChain: null,
        body: null,
      },
      body: null,
    });
    mockWidgetData({ state: "ok", payload: okPayload([bare]) });
    renderPage();
    await waitFor(() => expect(screen.getByTestId("messages-body-unreadable")).toBeDefined());
  });

  test("a known delivery with no indexed envelope is surfaced as a coverage gap", async () => {
    mockWidgetData({
      state: "ok",
      payload: okPayload([receivedEntry()], {
        ...COVERAGE,
        peerTurns: 2,
        envelopesRead: 1,
        envelopesMissing: 1,
      }),
    });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("messages-envelope-gap")).toBeDefined());
    expect(screen.getByTestId("messages-envelope-gap").textContent).toContain(
      "1 of 2 known deliveries"
    );
  });

  test("a truncated sender scan is stated rather than silently capping the view", async () => {
    mockWidgetData({
      state: "ok",
      payload: okPayload([sentEntry()], { ...COVERAGE, senderScanTruncated: true }),
    });
    renderPage();

    await waitFor(() => expect(screen.getByTestId("messages-scan-truncated")).toBeDefined());
    expect(screen.getByTestId("messages-scan-truncated").textContent).toContain(
      "newest 500 sends"
    );
  });
});
