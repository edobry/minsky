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
import { mountAskRoutes } from "./asks";
import { FakeAskRepository } from "@minsky/domain/ask/repository";
import type { Ask } from "@minsky/domain/ask/types";

const servers: Server[] = [];

const ASK_TITLE = "Rename decision: commit to a public brand name";

/** Seed one operator-routed Ask already sitting in the inbox (`suspended`). */
async function seedSuspendedOperatorAsk(repo: FakeAskRepository): Promise<Ask> {
  const ask = await repo.create({
    kind: "direction.decide",
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
  if (!reread) throw new Error("fixture re-read failed");
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
