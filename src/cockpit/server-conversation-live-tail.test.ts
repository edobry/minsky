/**
 * Tests for the GET /api/conversation/:agentSessionId/live-tail SSE endpoint
 * (mt#2749).
 *
 * Covers the HTTP-layer contract: unlike its workspace-keyed sibling
 * (`GET /api/agents/:id/live-tail`, covered by `server-live-tail.test.ts`),
 * this endpoint requires NO workspace/session-provider resolution and NO
 * `agent_transcripts` cwd LIKE query — it resolves the JSONL transcript file
 * directly from the `agentSessionId` path param. A missing DB degrades to the
 * `resolveJsonlPath` directory-scan fallback rather than a 503.
 *
 * Also exercises the full JSONL→SSE path end to end via the SAME injectable
 * fs/tailer/timing seams `live-tail-poller.test.ts` uses (in-memory `fsMod` +
 * `TailerLike` mock + a short `pollMs`) — no real disk I/O, per the
 * `custom/no-real-fs-in-tests` project convention — to confirm the endpoint
 * actually streams an appended block over a real HTTP/SSE connection, not
 * just that the route exists.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { createCockpitServer } from "./server";
import type { ResolveJsonlFsMod, TailerLike } from "./live-tail-poller";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = "test-conversation-live-tail-token";

async function startTestServer(
  opts?: Parameters<typeof createCockpitServer>[0]
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createCockpitServer({ overrideToken: TEST_TOKEN, ...opts });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
  const url = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return { url, close };
}

/** In-memory fs double for resolveJsonlPath's directory scan (mirrors live-tail-poller.test.ts). */
function makeMockFsMod(files: string[]): ResolveJsonlFsMod {
  const fileSet = new Set(files);
  const dirChildren: Map<string, string[]> = new Map();
  for (const fp of files) {
    const parts = fp.split("/");
    if (parts.length < 2) continue;
    const parentDir = parts.slice(0, -1).join("/");
    const entry = parts.at(-1) ?? "";
    const parentChildren = dirChildren.get(parentDir) ?? [];
    if (!dirChildren.has(parentDir)) dirChildren.set(parentDir, parentChildren);
    parentChildren.push(entry);

    const grandparentDir = parts.slice(0, -2).join("/");
    const subdirName = parts.at(-2) ?? "";
    const grandChildren = dirChildren.get(grandparentDir) ?? [];
    if (!dirChildren.has(grandparentDir)) dirChildren.set(grandparentDir, grandChildren);
    if (!grandChildren.includes(subdirName)) {
      grandChildren.push(subdirName);
    }
  }
  return {
    async readdirWithTypes(dir: string) {
      const children = dirChildren.get(dir) ?? [];
      return children.map((name) => {
        const fullPath = `${dir}/${name}`;
        const isDir = dirChildren.has(fullPath);
        return { name, isDirectory: () => isDir };
      });
    },
    fileExists(path: string) {
      return fileSet.has(path);
    },
  };
}

/** In-memory tailer double: queued lines are delivered on the NEXT readNew() after seeding. */
class MockTailer implements TailerLike {
  private queue: unknown[] = [];
  private seeded = false;

  queueLines(...lines: unknown[]): void {
    this.queue.push(...lines);
  }

  setOffset(): void {
    this.seeded = true;
  }

  forget(): void {
    // no-op — nothing to release for an in-memory double
  }

  async readNew<T = unknown>(): Promise<{ lines: T[] }> {
    if (!this.seeded) return { lines: [] as T[] };
    return { lines: this.queue.splice(0) as T[] };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/conversation/:agentSessionId/live-tail", () => {
  const closeList: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closeList.splice(0)) {
      await close();
    }
  });

  async function server(opts?: Parameters<typeof createCockpitServer>[0]) {
    const s = await startTestServer(opts);
    closeList.push(s.close);
    return s.url;
  }

  test("returns 404 (not 503) when no JSONL exists — no DB or workspace required", async () => {
    // No DB configured in the test environment AND the fake fs scan is empty
    // — this endpoint must NOT need either to respond.
    const url = await server({
      overrideConversationLiveTail: {
        claudeProjectsDirOverride: "/mock/claude/projects",
        fsMod: makeMockFsMod([]),
      },
    });
    const res = await fetch(`${url}/api/conversation/nonexistent-session/live-tail`);

    expect(res.status).toBe(404);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  test("endpoint is registered BEFORE the SPA catch-all (not swallowed by *)", async () => {
    const url = await server({
      overrideConversationLiveTail: {
        claudeProjectsDirOverride: "/mock/claude/projects",
        fsMod: makeMockFsMod([]),
      },
    });
    const res = await fetch(`${url}/api/conversation/test-id/live-tail`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).not.toContain("bundle not built");
  });

  test("empty :id path does not reach the live-tail handler (falls through to the SPA catch-all)", async () => {
    const url = await server({
      overrideConversationLiveTail: {
        claudeProjectsDirOverride: "/mock/claude/projects",
        fsMod: makeMockFsMod([]),
      },
    });
    // `/api/conversation//live-tail` does not match `:agentSessionId` (empty
    // segment), so Express skips the SSE route and the request falls through to
    // the SPA catch-all (`app.get("*")`). We therefore assert on the thing that
    // is actually invariant — the SSE HANDLER was NOT reached — rather than on
    // the status code: the catch-all legitimately returns 200 (the SPA shell)
    // when a bundle is present and a "bundle not built" 404 when it is not, so a
    // bare status check is bundle-state-dependent and flaky (mt#2749 review R1).
    // A response that is NOT `text/event-stream` proves the live-tail handler
    // never ran.
    const res = await fetch(`${url}/api/conversation//live-tail`);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).not.toContain("text/event-stream");
  });

  test("resolves the JSONL from agentSessionId alone and streams a live-appended block", async () => {
    const agentSessionId = "mt2749-live-test-session";
    const PROJECTS_ROOT = "/mock/claude/projects";
    const PROJ_SUBDIR = `${PROJECTS_ROOT}/encoded-project`;
    const FILE_PATH = `${PROJ_SUBDIR}/${agentSessionId}.jsonl`;

    const tailer = new MockTailer();
    // Queue the block BEFORE connecting — MockTailer only releases queued
    // lines on the FIRST readNew() call after setOffset() seeds it, modeling
    // "only appends after connect are streamed" the same way the real
    // JsonlTailer's byte-offset seeding does (see live-tail-poller.test.ts).
    tailer.queueLines({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "hello live" }] },
    });

    const url = await server({
      overrideConversationLiveTail: {
        claudeProjectsDirOverride: PROJECTS_ROOT,
        fsMod: makeMockFsMod([FILE_PATH]),
        tailer,
        statFn: async () => ({ size: 0 }),
        pollMs: 15,
      },
    });

    // AbortController (not just reader.cancel()) so the underlying socket is
    // actually destroyed once the test is done reading — otherwise the
    // client's keep-alive connection can stay pooled/open, hanging the
    // server's close() in afterEach() waiting for a connection that never
    // truly ends.
    const controller = new AbortController();
    const res = await fetch(`${url}/api/conversation/${agentSessionId}/live-tail`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    if (!reader) throw new Error("expected a readable response body");
    const decoder = new TextDecoder();

    // Read until the live-appended block arrives (pollMs is 15ms above).
    //
    // IMPORTANT: a ReadableStreamDefaultReader only ever has ONE logical
    // "next chunk" in flight — calling reader.read() again before a prior
    // call resolves queues a SECOND request that both resolve FIFO. Racing a
    // FRESH reader.read() against a timeout on every loop iteration abandons
    // the earlier pending read's promise whenever the timeout wins, so the
    // eventual chunk resolves an abandoned promise and this loop would spin
    // forever seeing nothing. Keep exactly ONE pending read in flight and
    // just keep re-racing IT against fresh timeouts until it resolves.
    let buffered = "";
    let sawBlock = false;
    let pendingRead: ReturnType<typeof reader.read> | null = null;
    // performance.now() (not Date.now()) — purely a monotonic elapsed-time
    // deadline for this polling loop, unrelated to path/file uniqueness; also
    // sidesteps the repo's no-real-fs-in-tests lint rule, which flags any
    // Date.now() arithmetic as a potential (real-fs) "unique path" pattern.
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline && !sawBlock) {
      if (!pendingRead) pendingRead = reader.read();
      const outcome = await Promise.race([
        pendingRead.then((r) => ({ timedOut: false as const, ...r })),
        new Promise<{ timedOut: true }>((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 100)
        ),
      ]);
      if (outcome.timedOut) continue;
      pendingRead = null;
      if (outcome.done) break;
      if (outcome.value) {
        buffered += decoder.decode(outcome.value, { stream: true });
        if (buffered.includes("hello live")) sawBlock = true;
      }
    }
    controller.abort();
    await reader.cancel().catch(() => {
      // Expected — the underlying request was just aborted above.
    });

    expect(sawBlock).toBe(true);
    expect(buffered).toContain('"rawJsonlType":"assistant"');
  }, 10_000);
});
