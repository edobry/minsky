/**
 * Tests for GET /api/cockpit/session-film/events and
 * GET /api/cockpit/session-film/sessions (mt#3184).
 */
import { describe, test, expect, afterEach } from "bun:test";
import type { Server } from "http";
import express from "express";
import {
  mountSessionFilmRoutes,
  filterAdmissiblePickerRows,
  type SessionFilmRouteOptions,
  type SessionFilmPickerRow,
} from "./session-film";
import type { SemanticEvent } from "@minsky/domain/transcripts/event-schema";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";
import { looksLikeConversationId } from "../conversation-id-space";

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
// mt#3225: the live-repro shape — a real, ingested subagent transcript id.
const AGENT_ID = "agent-ae944bce40bdc1dd6";

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

  // mt#3225 AT2: the operator-reported failure — an ingested agent-*
  // subagent transcript must return its ordered events, not `invalid_id`.
  test("returns ordered events for an agent-prefixed subagent-transcript id (mt#3225 AT2)", async () => {
    const events = [
      fakeEvent({ actor: { kind: "agent", agentSessionId: AGENT_ID } }),
      fakeEvent({
        tStart: "2026-07-24T00:00:01.000Z",
        actor: { kind: "agent", agentSessionId: AGENT_ID },
        target: { realm: "repo", id: "second" },
      }),
    ];
    let seenConversationId: string | undefined;
    const { url } = await makeHarness({
      overrideFetchEvents: async (conversationId) => {
        seenConversationId = conversationId;
        return { events, ingestedAt: "2026-07-20T00:00:00.000Z" };
      },
    });
    const res = await fetch(`${url}/api/cockpit/session-film/events?conversationId=${AGENT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: SemanticEvent[]; ingestedAt: string | null };
    expect(body.events).toEqual(events);
    expect(seenConversationId).toBe(AGENT_ID);
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

  // ADR-040 / mt#3268: this endpoint is UNGATED, by decision. It used to 422
  // a pre-cutoff conversation while `routes/context-inspector.ts` rendered
  // that same transcript in full one route over. The gate now binds only
  // where transcript bytes CROSS the operator's trust boundary — a file
  // export, an anonymous share link — not on the operator's own
  // authenticated read. If this test starts failing with a 422, someone
  // re-added the gate here without revisiting the ADR.
  test("200s for a pre-cutoff session — the scrub gate does not bind here (ADR-040)", async () => {
    const { url } = await makeHarness({
      overrideFetchEvents: async () => ({
        events: [fakeEvent()],
        ingestedAt: "2026-01-01T00:00:00.000Z", // before the 2026-07-18 cutoff
      }),
    });
    const res = await fetch(`${url}/api/cockpit/session-film/events?conversationId=${VALID_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: SemanticEvent[]; ingestedAt: string | null };
    expect(body.events).toHaveLength(1);
    expect(body.ingestedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("GET /api/cockpit/session-film/content (mt#3262 SC 5 / AT 5)", () => {
  function fakeBlock(turnIndex: number): SessionContextSnapshotBlock {
    return {
      id: `${VALID_ID}:turn:${turnIndex}`,
      type: "assistant-text",
      source: "observed",
      content: { role: "assistant", content: "hi" },
      timestamp: "2026-07-24T00:00:00.000Z",
      turnIndex,
      rawJsonlType: "assistant",
    };
  }

  test("400s when conversationId is missing", async () => {
    const { url } = await makeHarness();
    const res = await fetch(`${url}/api/cockpit/session-film/content`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_field");
  });

  test("404s (invalid_id) when conversationId isn't UUID-shaped", async () => {
    const { url } = await makeHarness();
    const res = await fetch(`${url}/api/cockpit/session-film/content?conversationId=not-a-uuid`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_id");
  });

  test("404s (session_not_found) when the fetcher has no transcript", async () => {
    const { url } = await makeHarness({
      overrideFetchContent: async () => null,
    });
    const res = await fetch(`${url}/api/cockpit/session-film/content?conversationId=${VALID_ID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("session_not_found");
  });

  test("returns the blocks + ingestedAt for a scrubbed (post-cutoff) session", async () => {
    const blocks = [fakeBlock(0), fakeBlock(1)];
    const { url } = await makeHarness({
      overrideFetchContent: async () => ({
        blocks,
        ingestedAt: "2026-07-20T00:00:00.000Z", // after the 2026-07-18 cutoff
      }),
    });
    const res = await fetch(`${url}/api/cockpit/session-film/content?conversationId=${VALID_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocks: unknown[]; ingestedAt: string | null };
    expect(body.blocks).toEqual(blocks);
    expect(body.ingestedAt).toBe("2026-07-20T00:00:00.000Z");
  });

  // mt#3262 AT5 originally required this endpoint to MIRROR the /events
  // scrub-gate refusal. ADR-040 / mt#3268 removed the gate from both, so the
  // mirroring requirement is preserved with its verdict inverted: same
  // decision, same code path, both ungated. See the /events counterpart above.
  test("200s for a pre-cutoff session — the scrub gate does not bind here (ADR-040)", async () => {
    const { url } = await makeHarness({
      overrideFetchContent: async () => ({
        blocks: [fakeBlock(0)],
        ingestedAt: "2026-01-01T00:00:00.000Z", // before the 2026-07-18 cutoff
      }),
    });
    const res = await fetch(`${url}/api/cockpit/session-film/content?conversationId=${VALID_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocks: unknown[]; ingestedAt: string | null };
    expect(body.blocks).toHaveLength(1);
    expect(body.ingestedAt).toBe("2026-01-01T00:00:00.000Z");
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
        },
      ],
    });
    const res = await fetch(`${url}/api/cockpit/session-film/sessions`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ agentSessionId: string }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.agentSessionId).toBe(VALID_ID);
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

  // mt#4727: two-project-fixture wiring test. `overrideListSessions` receives
  // whatever `projectId` the route resolved from `?project=` — an unresolvable
  // slug (no live DB in this test process) fails open to ALL_PROJECTS
  // (`undefined`), proving the route's own resolution + passthrough without
  // needing a real Postgres connection. The underlying
  // `eq(agentTranscriptsTable.projectId, ...)` filter this `projectId` drives
  // in `defaultListSessions` is the identical, already project-scope-tested
  // pattern used throughout this codebase (e.g. `asks.ts`).
  test("?project=<unresolvable slug> fails open to ALL_PROJECTS (projectId: undefined) reaching the lister", async () => {
    let capturedProjectId: string | undefined;
    const { url } = await makeHarness({
      overrideListSessions: async (projectId) => {
        capturedProjectId = projectId;
        return [];
      },
    });
    const res = await fetch(
      `${url}/api/cockpit/session-film/sessions?project=${encodeURIComponent("unknown/repo")}`
    );
    expect(res.status).toBe(200);
    expect(capturedProjectId).toBeUndefined();
  });

  test("no ?project= resolves to ALL_PROJECTS (projectId: undefined) reaching the lister", async () => {
    let capturedProjectId: string | undefined;
    const { url } = await makeHarness({
      overrideListSessions: async (projectId) => {
        capturedProjectId = projectId;
        return [];
      },
    });
    const res = await fetch(`${url}/api/cockpit/session-film/sessions`);
    expect(res.status).toBe(200);
    expect(capturedProjectId).toBeUndefined();
  });

  // Two-project fixture (mt#4727): a `getProjectScopeDb` fake resolving the
  // requested slug to a real project uuid, proving the route's ?project=
  // resolution reaches the lister as the CORRECT uuid — not just "some
  // truthy value" or the fail-open default.
  test("?project=<project A slug> resolves to project A's uuid, reaching the lister verbatim", async () => {
    const PROJECT_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const PROJECT_A_SLUG = "edobry/minsky";
    let capturedProjectId: string | undefined;
    const { url } = await makeHarness({
      overrideListSessions: async (projectId) => {
        capturedProjectId = projectId;
        return [];
      },
      getProjectScopeDb: async () => ({
        select() {
          return {
            from() {
              return {
                where() {
                  return {
                    limit() {
                      return Promise.resolve([{ id: PROJECT_A_ID, slug: PROJECT_A_SLUG }]);
                    },
                  };
                },
              };
            },
          };
        },
      }),
    });
    const res = await fetch(
      `${url}/api/cockpit/session-film/sessions?project=${encodeURIComponent(PROJECT_A_SLUG)}`
    );
    expect(res.status).toBe(200);
    expect(capturedProjectId).toBe(PROJECT_A_ID);
  });
});

// mt#3225 SC3/SC4/AT3: the picker and the events endpoint must share one
// admissibility predicate — `defaultListSessions` filters its DB rows
// through `filterAdmissiblePickerRows`, which is exported specifically so
// this structural anti-drift check doesn't need a live DB.
describe("filterAdmissiblePickerRows (mt#3225 SC3/SC4/AT3)", () => {
  function pickerRow(agentSessionId: string): SessionFilmPickerRow {
    return {
      agentSessionId,
      label: agentSessionId,
      startedAt: "2026-07-20T00:00:00.000Z",
      cwd: "/repo",
      ingestedAt: "2026-07-20T00:00:00.000Z",
    };
  }

  test("keeps only validator-admissible rows given all three observed id classes", () => {
    // The live mt#3225 breakdown: UUID rows, agent-* subagent-transcript
    // rows, and a diagnostic row that was never a real conversation.
    const rows = [pickerRow(VALID_ID), pickerRow(AGENT_ID), pickerRow("probe-mt3120-diagnostic")];

    const filtered = filterAdmissiblePickerRows(rows);

    expect(filtered.map((r) => r.agentSessionId)).toEqual([VALID_ID, AGENT_ID]);
    // Anti-drift assertion: every row this function returns is, by
    // construction, a subset of what looksLikeConversationId admits — this
    // is the structural guarantee SC4 asks for (picker output ⊆ validator-
    // admissible ids), not just a fixed-example check.
    for (const row of filtered) {
      expect(looksLikeConversationId(row.agentSessionId)).toBe(true);
    }
  });

  test("returns an empty array when no row is admissible", () => {
    const rows = [pickerRow("probe-mt3120-diagnostic"), pickerRow("not-a-real-id")];
    expect(filterAdmissiblePickerRows(rows)).toEqual([]);
  });
});
