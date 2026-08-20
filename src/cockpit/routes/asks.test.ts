/**
 * Tests for /api/asks defer + escalate inertness (mt#3491).
 *
 * Both endpoints used to call `repo.transition(askId, "routed")`. For an
 * operator-bound Ask that is a one-way trip: `GET /api/asks` lists `suspended`
 * only, and the component that would move `routed -> suspended`
 * (ServiceWindowReaper) has no production callsite. So pressing either button
 * silently removed the decision from the operator's queue forever — a
 * `direction.decide` Ask about a public brand name was lost that way for 23
 * days.
 *
 * These tests pin the fix: neither endpoint changes state, and the Ask remains
 * listed afterwards.
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "http";
import express from "express";
import {
  mountAskRoutes,
  parseAskStateFilter,
  parseFilteredLimit,
  DEFAULT_FILTERED_LIMIT,
  MAX_FILTERED_LIMIT,
} from "./asks";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import type { Ask, AskState } from "@minsky/domain/ask/types";

const servers: Server[] = [];

const ASK_TITLE = "Rename decision: commit to a public brand name";
const DECIDE_KIND = "direction.decide";
const REREAD_FAILED = "fixture re-read failed";

/** Seed one operator-routed Ask already sitting in the inbox (`suspended`). */
async function seedSuspendedOperatorAsk(repo: FakeAskRepository): Promise<Ask> {
  const ask = await repo.create({
    kind: DECIDE_KIND,
    classifierVersion: "v1",
    requestor: "test-agent",
    title: ASK_TITLE,
    question: "Which name do we commit to?",
    serviceStrategy: "scheduled",
    windowMissedCount: 0,
    forceImmediate: false,
    routingTarget: "operator",
  });
  repo._seedAtState({
    ...ask,
    state: "suspended",
    routingTarget: "operator",
    suspendedAt: new Date().toISOString(),
  });
  const reread = await repo.getById(ask.id);
  if (!reread) throw new Error(REREAD_FAILED);
  return reread;
}

async function makeHarness(repo: FakeAskRepository): Promise<{ url: string }> {
  const app = express();
  app.use(express.json());
  mountAskRoutes(app, { askRepoOverride: repo });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no ephemeral port");
  return { url: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe("/api/asks defer + escalate are inert (mt#3491)", () => {
  for (const action of ["defer", "escalate"] as const) {
    test(`POST /${action} leaves the Ask suspended`, async () => {
      const repo = new FakeAskRepository();
      const ask = await seedSuspendedOperatorAsk(repo);
      const { url } = await makeHarness(repo);

      const res = await fetch(`${url}/api/asks/${ask.id}/${action}`, { method: "POST" });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { ok: boolean; state: string; inert?: boolean };
      expect(body.ok).toBe(true);
      expect(body.state).toBe("suspended");
      expect(body.inert).toBe(true);

      // The row itself is untouched — this is the assertion that actually
      // catches the regression; the response body could lie.
      const persisted = await repo.getById(ask.id);
      expect(persisted?.state).toBe("suspended");
    });

    test(`POST /${action} keeps the Ask listed on the operator surface`, async () => {
      const repo = new FakeAskRepository();
      const ask = await seedSuspendedOperatorAsk(repo);
      const { url } = await makeHarness(repo);

      await fetch(`${url}/api/asks/${ask.id}/${action}`, { method: "POST" });

      // GET /api/asks is the operator's actual queue; disappearing from it is
      // the user-visible harm, so assert on the surface, not just the row.
      const listRes = await fetch(`${url}/api/asks`);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { asks: Array<{ id: string; title: string }> };
      expect(list.asks.map((a) => a.id)).toContain(ask.id);
    });
  }

  test("POST /escalate reports escalated:false — the adopted R1 behavior change", async () => {
    // The escalate path used to return `escalated: true`. Nothing is escalated
    // now, so `true` would be a false claim about what the call did. The field
    // is kept for shape stability and its value made honest; this test pins
    // that so it cannot drift back. Adoption was verified by a repo-wide grep:
    // no consumer reads `escalated` off this response.
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedOperatorAsk(repo);
    const { url } = await makeHarness(repo);

    const res = await fetch(`${url}/api/asks/${ask.id}/escalate`, { method: "POST" });
    const body = (await res.json()) as { escalated?: boolean };
    expect(body.escalated).toBe(false);
  });

  test("POST /defer omits the escalated field entirely", async () => {
    const repo = new FakeAskRepository();
    const ask = await seedSuspendedOperatorAsk(repo);
    const { url } = await makeHarness(repo);

    const res = await fetch(`${url}/api/asks/${ask.id}/defer`, { method: "POST" });
    const body = (await res.json()) as Record<string, unknown>;
    expect("escalated" in body).toBe(false);
  });

  test("POST /defer on an unknown id returns 404", async () => {
    const repo = new FakeAskRepository();
    const { url } = await makeHarness(repo);

    const res = await fetch(`${url}/api/asks/does-not-exist/defer`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/asks state filter (mt#4092)
//
// Before this filter existed, a resolved ask was reachable ONLY if you already
// held its deeplink: the per-id route resolves any state (mt#2669), but no list
// in the product would ever return it. These tests pin both halves — that the
// filtered path reaches every terminal state, and that the unfiltered path is
// still exactly the pending queue it has always been.
// ---------------------------------------------------------------------------

interface TerminalSeed {
  state: AskState;
  title: string;
  closedAt?: string;
  routingTarget?: string;
}

async function seedTerminalAsk(repo: FakeAskRepository, seed: TerminalSeed): Promise<Ask> {
  const ask = await repo.create({
    kind: DECIDE_KIND,
    classifierVersion: "v1",
    requestor: "test-agent",
    title: seed.title,
    question: `Question for ${seed.title}`,
    serviceStrategy: "scheduled",
    windowMissedCount: 0,
    forceImmediate: false,
    routingTarget: seed.routingTarget ?? "operator",
  });
  repo._seedAtState({
    ...ask,
    state: seed.state,
    routingTarget: seed.routingTarget ?? "operator",
    suspendedAt: new Date().toISOString(),
    closedAt: seed.closedAt,
  });
  const reread = await repo.getById(ask.id);
  if (!reread) throw new Error(REREAD_FAILED);
  return reread;
}

interface AskListBody {
  asks: { id: string; state: string; title: string; closedAt?: string }[];
  total: number;
  returned?: number;
  truncated?: boolean;
}

async function getAsks(url: string, query = ""): Promise<AskListBody> {
  const res = await fetch(`${url}/api/asks${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as AskListBody;
}

/** An operator ask the reaper has woken at window-open (mt#4313). */
async function seedRoutedOperatorAsk(repo: FakeAskRepository, title: string): Promise<Ask> {
  const ask = await repo.create({
    kind: DECIDE_KIND,
    classifierVersion: "v1",
    requestor: "test-agent",
    title,
    question: "Which name do we commit to?",
    serviceStrategy: "scheduled",
    windowMissedCount: 0,
    forceImmediate: false,
    routingTarget: "operator",
  });
  repo._seedAtState({ ...ask, state: "routed", routingTarget: "operator" });
  const reread = await repo.getById(ask.id);
  if (!reread) throw new Error(REREAD_FAILED);
  return reread;
}

describe("GET /api/asks pending queue spans routed (mt#4313)", () => {
  test("an ask the reaper woke at window-open stays in the unfiltered queue", async () => {
    const repo = new FakeAskRepository();
    const waiting = await seedSuspendedOperatorAsk(repo);
    const woken = await seedRoutedOperatorAsk(repo, "woken at window-open");
    const { url } = await makeHarness(repo);

    const body = await getAsks(url);

    expect(new Set(body.asks.map((a) => a.id))).toEqual(new Set([waiting.id, woken.id]));
  });

  test("a routed ask bound elsewhere than the operator stays out", async () => {
    const repo = new FakeAskRepository();
    const waiting = await seedSuspendedOperatorAsk(repo);
    const subagent = await repo.create({
      kind: "capability.escalate",
      classifierVersion: "v1",
      requestor: "test-agent",
      title: "dispatched to a subagent",
      question: "n/a",
      windowMissedCount: 0,
      forceImmediate: false,
      routingTarget: "subagent",
    });
    repo._seedAtState({ ...subagent, state: "routed", routingTarget: "subagent" });
    const { url } = await makeHarness(repo);

    const body = await getAsks(url);

    expect(body.asks.map((a) => a.id)).toEqual([waiting.id]);
  });
});

describe("GET /api/asks state filter (mt#4092)", () => {
  test("with no param, terminal asks are absent and the pending queue is unchanged", async () => {
    const repo = new FakeAskRepository();
    const pending = await seedSuspendedOperatorAsk(repo);
    await seedTerminalAsk(repo, { state: "closed", title: "already decided" });
    await seedTerminalAsk(repo, { state: "cancelled", title: "withdrawn" });
    await seedTerminalAsk(repo, { state: "expired", title: "timed out" });
    const { url } = await makeHarness(repo);

    const body = await getAsks(url);

    expect(body.asks.map((a) => a.id)).toEqual([pending.id]);
    expect(body.total).toBe(1);
    // The default branch's shape is unchanged too — no pagination fields.
    expect("returned" in body).toBe(false);
    expect("truncated" in body).toBe(false);
  });

  test("?state=terminal reaches an ask in EACH terminal state", async () => {
    const repo = new FakeAskRepository();
    await seedSuspendedOperatorAsk(repo);
    const closed = await seedTerminalAsk(repo, { state: "closed", title: "closed one" });
    const cancelled = await seedTerminalAsk(repo, { state: "cancelled", title: "cancelled one" });
    const expired = await seedTerminalAsk(repo, { state: "expired", title: "expired one" });
    const { url } = await makeHarness(repo);

    const body = await getAsks(url, "?state=terminal");

    expect(new Set(body.asks.map((a) => a.id))).toEqual(
      new Set([closed.id, cancelled.id, expired.id])
    );
    expect(body.total).toBe(3);
    expect(body.returned).toBe(3);
    expect(body.truncated).toBe(false);
  });

  test("?state=terminal excludes the pending queue", async () => {
    const repo = new FakeAskRepository();
    const pending = await seedSuspendedOperatorAsk(repo);
    await seedTerminalAsk(repo, { state: "closed", title: "closed one" });
    const { url } = await makeHarness(repo);

    const body = await getAsks(url, "?state=terminal");

    expect(body.asks.map((a) => a.id)).not.toContain(pending.id);
  });

  test("a non-operator terminal ask is excluded — reviewer rows are not the operator's decisions", async () => {
    const repo = new FakeAskRepository();
    const mine = await seedTerminalAsk(repo, { state: "closed", title: "mine" });
    await seedTerminalAsk(repo, {
      state: "closed",
      title: "reviewer bot review",
      routingTarget: "reviewer",
    });
    await seedTerminalAsk(repo, {
      state: "closed",
      title: "policy auto-resolve",
      routingTarget: "policy",
    });
    const { url } = await makeHarness(repo);

    const body = await getAsks(url, "?state=terminal");

    expect(body.asks.map((a) => a.id)).toEqual([mine.id]);
  });

  test("a single explicit state returns only that state", async () => {
    const repo = new FakeAskRepository();
    const closed = await seedTerminalAsk(repo, { state: "closed", title: "closed one" });
    await seedTerminalAsk(repo, { state: "expired", title: "expired one" });
    const { url } = await makeHarness(repo);

    const body = await getAsks(url, "?state=closed");

    expect(body.asks.map((a) => a.id)).toEqual([closed.id]);
  });

  test("results are ordered most-recently-concluded first", async () => {
    const repo = new FakeAskRepository();
    const older = await seedTerminalAsk(repo, {
      state: "closed",
      title: "older",
      closedAt: "2026-08-01T00:00:00.000Z",
    });
    const newer = await seedTerminalAsk(repo, {
      state: "closed",
      title: "newer",
      closedAt: "2026-08-12T00:00:00.000Z",
    });
    const { url } = await makeHarness(repo);

    const body = await getAsks(url, "?state=terminal");

    expect(body.asks.map((a) => a.id)).toEqual([newer.id, older.id]);
  });

  test("the list is capped, and reports the true match count alongside the cap", async () => {
    const repo = new FakeAskRepository();
    for (let i = 0; i < 5; i++) {
      await seedTerminalAsk(repo, {
        state: "closed",
        title: `decision ${i}`,
        closedAt: `2026-08-0${i + 1}T00:00:00.000Z`,
      });
    }
    const { url } = await makeHarness(repo);

    const body = await getAsks(url, "?state=terminal&limit=2");

    expect(body.returned).toBe(2);
    expect(body.total).toBe(5);
    expect(body.truncated).toBe(true);
    // The cap keeps the NEWEST rows, not an arbitrary two.
    expect(body.asks.map((a) => a.title)).toEqual(["decision 4", "decision 3"]);
  });

  test("an unknown state is a 400 naming the token, not a silently empty list", async () => {
    const repo = new FakeAskRepository();
    await seedTerminalAsk(repo, { state: "closed", title: "closed one" });
    const { url } = await makeHarness(repo);

    const res = await fetch(`${url}/api/asks?state=resolved`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("resolved");
  });

  test("the resolved row carries what was decided, and a pending row still carries nothing", async () => {
    const repo = new FakeAskRepository();
    await seedTerminalAsk(repo, {
      state: "closed",
      title: "decided",
      closedAt: "2026-08-12T00:00:00.000Z",
    });
    await seedSuspendedOperatorAsk(repo);
    const { url } = await makeHarness(repo);

    const resolved = await getAsks(url, "?state=terminal");
    expect(resolved.asks[0]?.closedAt).toBe("2026-08-12T00:00:00.000Z");

    const pendingBody = await getAsks(url);
    expect("closedAt" in (pendingBody.asks[0] ?? {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The palette + linkifier ask sources (mt#4095)
//
// Both surfaces used to read the attention widget's cohort — pending operator
// asks only — so the palette could not find a resolved ask and an `ask#N` in
// prose stopped linkifying the moment its ask closed.
// ---------------------------------------------------------------------------

describe("GET /api/asks/ids (mt#4095)", () => {
  test("returns pairs for terminal asks, not just pending ones", async () => {
    const repo = new FakeAskRepository();
    const pending = await seedSuspendedOperatorAsk(repo);
    const closed = await seedTerminalAsk(repo, { state: "closed", title: "resolved" });
    const cancelled = await seedTerminalAsk(repo, { state: "cancelled", title: "withdrawn" });
    const expired = await seedTerminalAsk(repo, { state: "expired", title: "timed out" });
    for (const [i, a] of [pending, closed, cancelled, expired].entries()) {
      repo._seedAtState({ ...a, shortId: `ask#${100 + i}` });
    }
    const { url } = await makeHarness(repo);

    const res = await fetch(`${url}/api/asks/ids`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ids: { shortId: string; id: string }[] };

    expect(new Set(body.ids.map((r) => r.shortId))).toEqual(
      new Set(["ask#100", "ask#101", "ask#102", "ask#103"])
    );
    // The uuid is what a deeplink targets (ADR-029) — the pair must carry it.
    const closedPair = body.ids.find((r) => r.shortId === "ask#101");
    expect(closedPair?.id).toBe(closed.id);
  });

  test("is not swallowed by the /api/asks/:id route", async () => {
    // Express matches first-registered-wins, so `/api/asks/ids` must be
    // declared before `/api/asks/:id` or "ids" is read as an ask id and this
    // returns 404 for a route that exists.
    const repo = new FakeAskRepository();
    const { url } = await makeHarness(repo);

    const res = await fetch(`${url}/api/asks/ids`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ids: unknown[] }).toEqual({ ids: [] });
  });

  test("omits legacy rows that have no short id", async () => {
    const repo = new FakeAskRepository();
    const withShortId = await seedTerminalAsk(repo, { state: "closed", title: "modern" });
    repo._seedAtState({ ...withShortId, shortId: "ask#200" });
    const legacy = await seedTerminalAsk(repo, { state: "closed", title: "legacy" });
    repo._seedAtState({ ...legacy, shortId: undefined });
    const { url } = await makeHarness(repo);

    const body = (await (await fetch(`${url}/api/asks/ids`)).json()) as {
      ids: { shortId: string; id: string }[];
    };

    expect(body.ids.map((r) => r.id)).toEqual([withShortId.id]);
  });

  test("excludes asks routed somewhere other than the operator", async () => {
    const repo = new FakeAskRepository();
    const mine = await seedTerminalAsk(repo, { state: "closed", title: "mine" });
    repo._seedAtState({ ...mine, shortId: "ask#300" });
    const reviewers = await seedTerminalAsk(repo, {
      state: "closed",
      title: "reviewer's",
      routingTarget: "reviewer",
    });
    repo._seedAtState({ ...reviewers, shortId: "ask#301", routingTarget: "reviewer" });
    const { url } = await makeHarness(repo);

    const body = (await (await fetch(`${url}/api/asks/ids`)).json()) as {
      ids: { shortId: string }[];
    };

    expect(body.ids.map((r) => r.shortId)).toEqual(["ask#300"]);
  });
});

describe("GET /api/asks?summary=true (mt#4095)", () => {
  test("drops the body and keeps what a search result needs", async () => {
    const repo = new FakeAskRepository();
    const closed = await seedTerminalAsk(repo, { state: "closed", title: "already decided" });
    repo._seedAtState({ ...closed, shortId: "ask#400" });
    const { url } = await makeHarness(repo);

    const res = await fetch(`${url}/api/asks?state=terminal&summary=true`);
    const body = (await res.json()) as { asks: Record<string, unknown>[] };
    const row = body.asks[0] as Record<string, unknown>;

    expect(row.shortId).toBe("ask#400");
    expect(row.title).toBe("already decided");
    expect(row.state).toBe("closed");
    // The body — the ~3.3 KB this projection exists to drop.
    expect("question" in row).toBe(false);
    expect("options" in row).toBe(false);
    expect("metadata" in row).toBe(false);
    expect("response" in row).toBe(false);
  });

  test("without summary, the full row still carries the body", async () => {
    const repo = new FakeAskRepository();
    await seedTerminalAsk(repo, { state: "closed", title: "already decided" });
    const { url } = await makeHarness(repo);

    const body = (await (await fetch(`${url}/api/asks?state=terminal`)).json()) as {
      asks: Record<string, unknown>[];
    };

    expect("question" in (body.asks[0] as Record<string, unknown>)).toBe(true);
  });

  test("the palette's own query reaches pending AND terminal asks in one request", async () => {
    const repo = new FakeAskRepository();
    const pending = await seedSuspendedOperatorAsk(repo);
    const closed = await seedTerminalAsk(repo, { state: "closed", title: "resolved one" });
    const { url } = await makeHarness(repo);

    const body = (await (
      await fetch(`${url}/api/asks?state=suspended,terminal&summary=true&limit=2000`)
    ).json()) as { asks: { id: string }[] };

    expect(new Set(body.asks.map((a) => a.id))).toEqual(new Set([pending.id, closed.id]));
  });
});

describe("parseAskStateFilter (mt#4092)", () => {
  const known = {
    all: ["suspended", "closed", "cancelled", "expired"],
    terminal: ["closed", "cancelled", "expired"],
  };

  test("no value means no filter — the caller gets the historical default", () => {
    expect(parseAskStateFilter(undefined, known)).toEqual({ ok: true, states: null });
    expect(parseAskStateFilter("", known)).toEqual({ ok: true, states: null });
    expect(parseAskStateFilter("  ", known)).toEqual({ ok: true, states: null });
  });

  test("the terminal alias expands to every terminal state", () => {
    expect(parseAskStateFilter("terminal", known)).toEqual({
      ok: true,
      states: ["closed", "cancelled", "expired"],
    });
  });

  test("a comma list and a repeated param are the same thing", () => {
    expect(parseAskStateFilter("closed,expired", known)).toEqual({
      ok: true,
      states: ["closed", "expired"],
    });
    expect(parseAskStateFilter(["closed", "expired"], known)).toEqual({
      ok: true,
      states: ["closed", "expired"],
    });
  });

  test("overlapping tokens dedupe rather than double-gathering a state", () => {
    expect(parseAskStateFilter("terminal,closed", known)).toEqual({
      ok: true,
      states: ["closed", "cancelled", "expired"],
    });
  });

  test("unknown tokens are reported, not dropped", () => {
    expect(parseAskStateFilter("closed,bogus", known)).toEqual({ ok: false, invalid: ["bogus"] });
  });
});

describe("parseFilteredLimit (mt#4092)", () => {
  test("absent or unparseable falls back to the default", () => {
    expect(parseFilteredLimit(undefined)).toBe(DEFAULT_FILTERED_LIMIT);
    expect(parseFilteredLimit("not-a-number")).toBe(DEFAULT_FILTERED_LIMIT);
    expect(parseFilteredLimit("0")).toBe(DEFAULT_FILTERED_LIMIT);
    expect(parseFilteredLimit("-5")).toBe(DEFAULT_FILTERED_LIMIT);
  });

  test("a caller-supplied limit is honored up to the ceiling", () => {
    expect(parseFilteredLimit("25")).toBe(25);
    expect(parseFilteredLimit(String(MAX_FILTERED_LIMIT + 1000))).toBe(MAX_FILTERED_LIMIT);
  });
});
