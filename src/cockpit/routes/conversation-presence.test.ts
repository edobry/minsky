/**
 * Tests for GET /api/conversation/:id/presence (mt#3201, mt#3130 Phase 2).
 *
 * Every reader is EXPLICITLY injected via `overrideConversationPresence`
 * rather than relying on "no real Postgres in the test environment" as an
 * ambient property — see conversation-search.test.ts's header for the mt#3016
 * writeup on why that ambient assumption is unsafe across test files sharing a
 * process.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { createCockpitServer } from "../server";
import { foldAskIntoPresence } from "./conversation-presence";
import type { ConversationPresenceRoutesOptions } from "./conversation-presence";
import type { ConversationRunStateRecord } from "@minsky/domain/storage/schemas/conversation-run-state-schema";
import type { LinkedOpenAsk } from "@minsky/domain/conversation-run-state/read";
import type { ConversationPresenceResult } from "@minsky/domain/conversation-run-state/presence";

const TEST_TOKEN = "test-conversation-presence-token";
const NOW = new Date("2026-07-25T12:00:00.000Z");
/** A syntactically-valid conversation id (harness ids are UUIDs). */
const CONV_ID = "2c14c722-35b4-4a63-a095-eee2407b20a4";

function makeRow(overrides: Partial<ConversationRunStateRecord> = {}): ConversationRunStateRecord {
  return {
    conversationId: CONV_ID,
    lastEventName: "Stop",
    lastEventAt: NOW,
    activity: "idle",
    toolName: null,
    toolStartedAt: null,
    promptId: null,
    needsInputReason: null,
    needsInputTool: null,
    needsInputAt: null,
    lastErrorType: null,
    lastErrorMessage: null,
    lastErrorAt: null,
    lastCompactionTrigger: null,
    lastCompactionAt: null,
    lastCompactionEndedAt: null,
    endedHintAt: null,
    endedHintReason: null,
    cwd: null,
    projectId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ConversationRunStateRecord;
}

const servers: Array<() => Promise<void>> = [];

async function startTestServer(presence: ConversationPresenceRoutesOptions = {}): Promise<string> {
  const app = createCockpitServer({
    overrideToken: TEST_TOKEN,
    overrideConversationPresence: { now: () => NOW, ...presence },
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
  servers.push(
    () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  );
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  while (servers.length > 0) {
    const close = servers.pop();
    if (close) await close();
  }
});

describe("GET /api/conversation/:id/presence", () => {
  test("no run-state row -> HTTP 200 UNKNOWN, never 404 and never a claim that it ended", async () => {
    const url = await startTestServer({
      getRunState: async () => null,
      findOpenAsk: async () => null,
      isKnownWorkspaceId: async () => false,
    });

    const res = await fetch(`${url}/api/conversation/${CONV_ID}/presence`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConversationPresenceResult & { conversationId: string };
    expect(body.presence).toBe("UNKNOWN");
    expect(body.presence).not.toBe("ENDED");
    expect(body.conversationId).toBe(CONV_ID);
  });

  test("a non-UUID id is rejected with zero I/O and copy that does NOT hedge 'may still be running'", async () => {
    let readerCalled = false;
    const url = await startTestServer({
      getRunState: async () => {
        readerCalled = true;
        return null;
      },
    });

    const res = await fetch(`${url}/api/conversation/958f3805/presence`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_id");
    expect(body.error.message).not.toContain("may still be running");
    // Zero I/O: the store was never consulted for an impossible id.
    expect(readerCalled).toBe(false);
  });

  test("a workspace session id passed where a conversation id belongs -> 422 wrong_id_space, not a bland UNKNOWN", async () => {
    const url = await startTestServer({
      getRunState: async () => null,
      isKnownWorkspaceId: async () => true,
    });

    const res = await fetch(`${url}/api/conversation/${CONV_ID}/presence`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("wrong_id_space");
  });

  test("store unreachable -> 503, never a confident UNKNOWN", async () => {
    // `undefined` is the route's explicit "no store" signal, distinct from
    // `null` ("store reached, no row"). Collapsing the two is the silent-
    // failure class this contract exists to avoid.
    const url = await startTestServer({ getRunState: async () => undefined });

    const res = await fetch(`${url}/api/conversation/${CONV_ID}/presence`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("store_unavailable");
  });

  test("a throwing reader also yields 503 rather than degrading to UNKNOWN", async () => {
    const url = await startTestServer({
      getRunState: async () => {
        throw new Error("connection reset — exercises the fail-loud path");
      },
    });

    const res = await fetch(`${url}/api/conversation/${CONV_ID}/presence`);
    expect(res.status).toBe(503);
  });

  test("a harness-native needs-input renders NEEDS_INPUT with its reason and NO ask", async () => {
    const url = await startTestServer({
      getRunState: async () =>
        makeRow({ needsInputReason: "permission_request", needsInputTool: "Write" }),
      findOpenAsk: async () => null,
    });

    const res = await fetch(`${url}/api/conversation/${CONV_ID}/presence`);
    const body = (await res.json()) as ConversationPresenceResult & { ask: LinkedOpenAsk | null };
    expect(body.presence).toBe("NEEDS_INPUT");
    expect(body.needsInputReason).toBe("permission");
    expect(body.needsInputTool).toBe("Write");
    expect(body.ask).toBeNull();
  });

  test("an open Ask upgrades an IDLE conversation to NEEDS_INPUT (ask) and is attached for the deeplink", async () => {
    const ask: LinkedOpenAsk = {
      id: "ask-uuid",
      shortId: "6024",
      title: "Approve the migration",
      minskySessionId: "ws-uuid",
    };
    const url = await startTestServer({
      getRunState: async () => makeRow({ activity: "idle" }),
      findOpenAsk: async () => ask,
    });

    const res = await fetch(`${url}/api/conversation/${CONV_ID}/presence`);
    const body = (await res.json()) as ConversationPresenceResult & { ask: LinkedOpenAsk | null };
    expect(body.presence).toBe("NEEDS_INPUT");
    expect(body.needsInputReason).toBe("ask");
    expect(body.ask?.id).toBe("ask-uuid");
  });

  test("a failing ask join degrades to no-ask rather than failing the request", async () => {
    const url = await startTestServer({
      getRunState: async () => makeRow({ activity: "idle" }),
      findOpenAsk: async () => {
        throw new Error("join failed — exercises the best-effort path");
      },
    });

    const res = await fetch(`${url}/api/conversation/${CONV_ID}/presence`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConversationPresenceResult & { ask: LinkedOpenAsk | null };
    // The absence must not be reported as "no ask exists" — it is simply
    // unresolved, and presence falls back to the row-derived value.
    expect(body.presence).toBe("IDLE");
    expect(body.ask).toBeNull();
  });

  test("a live conversation reports LIVE with the in-flight tool and elapsed time", async () => {
    const url = await startTestServer({
      getRunState: async () =>
        makeRow({
          activity: "running",
          toolName: "Bash",
          toolStartedAt: new Date(NOW.getTime() - 3_000),
          lastEventAt: new Date(NOW.getTime() - 3_000),
        }),
      findOpenAsk: async () => null,
    });

    const res = await fetch(`${url}/api/conversation/${CONV_ID}/presence`);
    const body = (await res.json()) as ConversationPresenceResult;
    expect(body.presence).toBe("LIVE");
    expect(body.toolName).toBe("Bash");
    expect(body.toolElapsedMs).toBe(3_000);
  });
});

describe("foldAskIntoPresence", () => {
  const ask: LinkedOpenAsk = {
    id: "a",
    shortId: null,
    title: "t",
    minskySessionId: "w",
  };
  const base: ConversationPresenceResult = {
    presence: "IDLE",
    needsInputReason: null,
    needsInputTool: null,
    toolName: null,
    toolElapsedMs: null,
    quietForMs: 0,
    isQuiet: false,
    basis: "stopped",
  };

  test("IDLE + open ask -> NEEDS_INPUT (ask)", () => {
    const result = foldAskIntoPresence(base, ask);
    expect(result.presence).toBe("NEEDS_INPUT");
    expect(result.needsInputReason).toBe("ask");
  });

  test("LIVE is NOT downgraded by an open ask — what it is doing now is the more specific answer", () => {
    const result = foldAskIntoPresence({ ...base, presence: "LIVE" }, ask);
    expect(result.presence).toBe("LIVE");
  });

  test("STALLED is not overwritten either", () => {
    const result = foldAskIntoPresence({ ...base, presence: "STALLED" }, ask);
    expect(result.presence).toBe("STALLED");
  });

  test("a harness-native NEEDS_INPUT keeps its more precise reason", () => {
    const harness: ConversationPresenceResult = {
      ...base,
      presence: "NEEDS_INPUT",
      needsInputReason: "permission",
    };
    const result = foldAskIntoPresence(harness, ask);
    expect(result.needsInputReason).toBe("permission");
  });

  test("no ask is a no-op", () => {
    expect(foldAskIntoPresence(base, null)).toEqual(base);
  });
});
