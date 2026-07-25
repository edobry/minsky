/**
 * Tests for GET /api/cockpit/session-film/events and
 * GET /api/cockpit/session-film/sessions (mt#3184).
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "http";
import express from "express";
import { mountSessionFilmRoutes, type SessionFilmRouteOptions } from "./session-film";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";

const servers: Server[] = [];

async function makeHarness(opts: SessionFilmRouteOptions = {}): Promise<{ url: string }> {
  const app = express();
  mountSessionFilmRoutes(app, opts);
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

const VALID_ID = "12345678-1234-1234-1234-123456789012";

function fakeEvent(overrides: Partial<SemanticEvent> = {}): SemanticEvent {
  return {
    schemaVersion: "v0",
    tStart: "2026-07-24T00:00:00.000Z",
    actor: { kind: "agent", agentSessionId: VALID_ID },
    verb: "read",
    target: { realm: "repo", id: "file:workspace:foo.ts" },
    outcome: "ok",
    weight: 1,
    adapterVersion: "test",
    ...overrides,
  };
}

describe("GET /api/cockpit/session-film/events", () => {
  test("400s when conversationId is missing", async () => {
    const { url } = await makeHarness();
    const res = await fetch(`${url}/api/cockpit/session-film/events`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_field");
  });

  test("404s (invalid_id) when conversationId isn't UUID-shaped", async () => {
    const { url } = await makeHarness();
    const res = await fetch(`${url}/api/cockpit/session-film/events?conversationId=not-a-uuid`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_id");
  });

  test("404s (session_not_found) when the adapter has no transcript", async () => {
    const { url } = await makeHarness({
      overrideFetchEvents: async () => null,
    });
    const res = await fetch(`${url}/api/cockpit/session-film/events?conversationId=${VALID_ID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("session_not_found");
  });

  test("returns the ordered event array + ingestedAt for a scrubbed (post-cutoff) session", async () => {
    const events = [fakeEvent()];
    const { url } = await makeHarness({
      overrideFetchEvents: async () => ({
        events,
        ingestedAt: "2026-07-20T00:00:00.000Z", // after the 2026-07-18 cutoff
      }),
    });
    const res = await fetch(`${url}/api/cockpit/session-film/events?conversationId=${VALID_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: SemanticEvent[]; ingestedAt: string | null };
    expect(body.events).toEqual(events);
    expect(body.ingestedAt).toBe("2026-07-20T00:00:00.000Z");
  });

  test("stable-sorts a transposed adjacent pair by tStart (mt#3188 AT1)", async () => {
    const early = fakeEvent({
      tStart: "2026-07-24T00:00:00.010Z",
      target: { realm: "repo", id: "early" },
    });
    const late = fakeEvent({
      tStart: "2026-07-24T00:00:00.020Z",
      target: { realm: "repo", id: "late" },
    });
    // Adapter emits them transposed (late before early), mirroring the
    // mt#3184 outcome's exact 14ms adjacent-`ask`-event inversion.
    const events = [late, early];
    const { url } = await makeHarness({
      overrideFetchEvents: async () => ({
        events,
        ingestedAt: "2026-07-20T00:00:00.000Z",
      }),
    });
    const res = await fetch(`${url}/api/cockpit/session-film/events?conversationId=${VALID_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: SemanticEvent[] };
    expect(body.events.map((e) => e.target.id)).toEqual(["early", "late"]);
  });

  test("preserves relative emission order within a shared-tStart batch (mt#3188 AT1)", async () => {
    const before = fakeEvent({
      tStart: "2026-07-24T00:00:00.000Z",
      target: { realm: "repo", id: "before" },
    });
    const batchA = fakeEvent({
      tStart: "2026-07-24T00:00:01.000Z",
      batchId: "b1",
      target: { realm: "repo", id: "batch-a" },
    });
    const batchB = fakeEvent({
      tStart: "2026-07-24T00:00:01.000Z",
      batchId: "b1",
      target: { realm: "repo", id: "batch-b" },
    });
    const batchC = fakeEvent({
      tStart: "2026-07-24T00:00:01.000Z",
      batchId: "b1",
      target: { realm: "repo", id: "batch-c" },
    });
    const after = fakeEvent({
      tStart: "2026-07-24T00:00:02.000Z",
      target: { realm: "repo", id: "after" },
    });
    // All three batch members share an exact tStart — the sort must be
    // stable so their relative (emission) order is preserved, never
    // inventing an intra-batch order, while still ordering around them.
    const events = [before, batchA, batchB, batchC, after];
    const { url } = await makeHarness({
      overrideFetchEvents: async () => ({
        events,
        ingestedAt: "2026-07-20T00:00:00.000Z",
      }),
    });
    const res = await fetch(`${url}/api/cockpit/session-film/events?conversationId=${VALID_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: SemanticEvent[] };
    expect(body.events.map((e) => e.target.id)).toEqual([
      "before",
      "batch-a",
      "batch-b",
      "batch-c",
      "after",
    ]);
  });

  test("422s (unscrubbed) for a pre-cutoff session with no verifiedRescrubbed assertion", async () => {
    const { url } = await makeHarness({
      overrideFetchEvents: async () => ({
        events: [fakeEvent()],
        ingestedAt: "2026-01-01T00:00:00.000Z", // before the 2026-07-18 cutoff
      }),
    });
    const res = await fetch(`${url}/api/cockpit/session-film/events?conversationId=${VALID_ID}`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unscrubbed");
  });

  test("200s for a pre-cutoff session when verifiedRescrubbed=true is asserted", async () => {
    const { url } = await makeHarness({
      overrideFetchEvents: async () => ({
        events: [fakeEvent()],
        ingestedAt: "2026-01-01T00:00:00.000Z",
      }),
    });
    const res = await fetch(
      `${url}/api/cockpit/session-film/events?conversationId=${VALID_ID}&verifiedRescrubbed=true`
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/cockpit/session-film/sessions", () => {
  test("returns the picker rows verbatim from the injected lister", async () => {
    const { url } = await makeHarness({
      overrideListSessions: async () => [
        {
          agentSessionId: VALID_ID,
          label: "test session",
          startedAt: "2026-07-20T00:00:00.000Z",
          cwd: "/repo",
          ingestedAt: "2026-07-20T00:00:00.000Z",
          scrubGateOk: true,
        },
      ],
    });
    const res = await fetch(`${url}/api/cockpit/session-film/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ scrubGateOk: boolean }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.scrubGateOk).toBe(true);
  });

  test("500s cleanly when the lister throws", async () => {
    const { url } = await makeHarness({
      overrideListSessions: async () => {
        throw new Error("boom");
      },
    });
    const res = await fetch(`${url}/api/cockpit/session-film/sessions`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal");
  });
});
