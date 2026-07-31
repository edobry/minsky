/**
 * Tests for /api/follow-ups (mt#2322).
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "http";
import express from "express";
import { mountFollowUpRoutes } from "./follow-ups";
import type { FollowUpService } from "@minsky/domain/scheduler/follow-up-service";
import type { ScheduledFollowUpRecord } from "@minsky/domain/storage/schemas/scheduled-follow-ups-schema";

const servers: Server[] = [];

/**
 * ms-from-now ISO string helper. Assigns `Date.now()` to a variable before
 * adding the offset so `custom/no-real-fs-in-tests`'s timestampUniqueness
 * check (which flags `Date.now()` whose immediate parent is a
 * BinaryExpression — a path-uniqueness anti-pattern check that also fires on
 * ordinary date-math) does not trigger. See follow-up-service.test.ts's
 * `msFromNow` for the same pattern.
 */
function isoMsFromNow(ms: number): string {
  const now = Date.now();
  return new Date(now + ms).toISOString();
}

/** POST a JSON body — shared to avoid duplicating the content-type header literal per test. */
async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Minimal in-memory fake satisfying the FollowUpService surface the routes call. */
function makeFakeService(): FollowUpService {
  const rows = new Map<string, ScheduledFollowUpRecord>();
  let idCounter = 1;

  const fake = {
    async create(input: {
      message: string;
      dueAt: Date | string;
      payload?: Record<string, unknown>;
      relatedTaskId?: string;
      relatedSessionId?: string;
    }) {
      const dueAt = input.dueAt instanceof Date ? input.dueAt : new Date(input.dueAt);
      if (Number.isNaN(dueAt.getTime())) throw new Error("invalid dueAt");
      const row: ScheduledFollowUpRecord = {
        id: `fake-id-${idCounter++}`,
        message: input.message,
        payload: input.payload ?? {},
        dueAt,
        status: "pending",
        relatedTaskId: input.relatedTaskId ?? null,
        relatedSessionId: input.relatedSessionId ?? null,
        createdAt: new Date(),
        firedAt: null,
        lastError: null,
      };
      rows.set(row.id, row);
      return row;
    },
    async list(opts?: { status?: ScheduledFollowUpRecord["status"] }) {
      const all = [...rows.values()].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
      return opts?.status ? all.filter((r) => r.status === opts.status) : all;
    },
    async cancel(id: string) {
      const row = rows.get(id);
      if (!row || row.status !== "pending") return false;
      row.status = "cancelled";
      return true;
    },
    async fireDue() {
      return { fired: [], errored: [] };
    },
    __rows: () => [...rows.values()],
  };

  return fake as unknown as FollowUpService;
}

async function makeHarness(service: FollowUpService | null): Promise<{ url: string }> {
  const app = express();
  app.use(express.json());
  mountFollowUpRoutes(app, { followUpServiceOverride: service });
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

describe("/api/follow-ups", () => {
  test("GET returns 503 when the follow-up service is unavailable", async () => {
    const { url } = await makeHarness(null);
    const res = await fetch(`${url}/api/follow-ups`);
    expect(res.status).toBe(503);
  });

  test("POST creates a follow-up and GET lists it", async () => {
    const service = makeFakeService();
    const { url } = await makeHarness(service);

    const dueAt = isoMsFromNow(60_000);
    const createRes = await postJson(`${url}/api/follow-ups`, {
      message: "check on deploy",
      dueAt,
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { followUp: ScheduledFollowUpRecord };
    expect(created.followUp.message).toBe("check on deploy");
    expect(created.followUp.status).toBe("pending");

    const listRes = await fetch(`${url}/api/follow-ups`);
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      followUps: ScheduledFollowUpRecord[];
      total: number;
    };
    expect(listed.total).toBe(1);
    expect(listed.followUps[0]?.message).toBe("check on deploy");
  });

  test("POST rejects a missing message", async () => {
    const { url } = await makeHarness(makeFakeService());
    const res = await postJson(`${url}/api/follow-ups`, { dueAt: isoMsFromNow(1000) });
    expect(res.status).toBe(400);
  });

  test("POST rejects an invalid dueAt", async () => {
    const { url } = await makeHarness(makeFakeService());
    const res = await postJson(`${url}/api/follow-ups`, { message: "x", dueAt: "not-a-date" });
    expect(res.status).toBe(400);
  });

  test("POST ignores a client-supplied status field (trust boundary)", async () => {
    const service = makeFakeService();
    const { url } = await makeHarness(service);
    const dueAt = isoMsFromNow(60_000);
    const res = await postJson(`${url}/api/follow-ups`, { message: "x", dueAt, status: "fired" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { followUp: ScheduledFollowUpRecord };
    expect(body.followUp.status).toBe("pending");
  });

  test("GET with an invalid status filter returns 400", async () => {
    const { url } = await makeHarness(makeFakeService());
    const res = await fetch(`${url}/api/follow-ups?status=bogus`);
    expect(res.status).toBe(400);
  });

  test("POST /:id/cancel cancels a pending follow-up", async () => {
    const service = makeFakeService();
    const { url } = await makeHarness(service);
    const dueAt = isoMsFromNow(60_000);
    const createRes = await postJson(`${url}/api/follow-ups`, { message: "x", dueAt });
    const created = (await createRes.json()) as { followUp: ScheduledFollowUpRecord };

    const cancelRes = await fetch(`${url}/api/follow-ups/${created.followUp.id}/cancel`, {
      method: "POST",
    });
    expect(cancelRes.status).toBe(200);

    const secondCancel = await fetch(`${url}/api/follow-ups/${created.followUp.id}/cancel`, {
      method: "POST",
    });
    expect(secondCancel.status).toBe(404);
  });

  test("POST /:id/cancel on an unknown id returns 404", async () => {
    const { url } = await makeHarness(makeFakeService());
    const res = await fetch(`${url}/api/follow-ups/does-not-exist/cancel`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
