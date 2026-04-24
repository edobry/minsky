/**
 * HTTP transport multi-session tests for MinskyMCPServer (mt#1175 / mt#1192).
 *
 * Exercises the real MCP SDK StreamableHTTP stack (no mocks) to verify:
 *   1. Back-to-back non-initialize POSTs without mcp-session-id return 400
 *      JSON-RPC (-32600), never 500 ("Already connected to a transport").
 *   2. Full initialize -> mcp-session-id -> tools/list round-trip succeeds.
 *   3. Two independent initialize calls produce distinct session ids and
 *      each session can call tools/list without interfering with the other.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import express, { type Request, type Response as ExpressResponse } from "express";
import type { Server as HttpServer } from "node:http";
import { MinskyMCPServer } from "./server";

const INVALID_REQUEST = -32600;
const PROTOCOL_VERSION = "2025-06-18";

interface TestHarness {
  url: string;
  stop: () => Promise<void>;
}

async function startTestServer(): Promise<TestHarness> {
  const mcp = new MinskyMCPServer({
    name: "Test MCP Server",
    version: "0.0.0-test",
    transportType: "http",
    projectContext: { repositoryPath: "/tmp/mt1192-test-repo" },
  });
  mcp.addTool({
    name: "ping",
    description: "test tool",
    inputSchema: { type: "object" },
    handler: async () => ({ pong: true }),
  });
  await mcp.start();

  const app = express();
  app.use(express.json());
  app.all("/mcp", async (req: Request, res: ExpressResponse) => {
    await mcp.handleHttpRequest(req, res);
  });

  const httpServer: HttpServer = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to get ephemeral port");
  }
  const url = `http://127.0.0.1:${addr.port}/mcp`;

  return {
    url,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await mcp.close();
    },
  };
}

const MCP_ACCEPT = "application/json, text/event-stream";

function postJSON(url: string, body: unknown, sessionId?: string): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function initializeBody(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mt1192-test-client", version: "1.0.0" },
    },
  };
}

describe("MinskyMCPServer HTTP transport multi-session (mt#1175)", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await startTestServer();
  });

  afterEach(async () => {
    await harness.stop();
  });

  test("two back-to-back non-initialize POSTs without mcp-session-id both return 400 JSON-RPC -32600 (regression: mt#1175 500 'Already connected to a transport')", async () => {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    };

    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await postJSON(harness.url, body);
      expect(res.status).toBe(400);
      const json = (await res.json()) as {
        jsonrpc: string;
        error?: { code: number };
        id: unknown;
      };
      expect(json.jsonrpc).toBe("2.0");
      expect(json.error?.code).toBe(INVALID_REQUEST);
      expect(json.id).toBeNull();
    }
  });

  test("full initialize -> mcp-session-id -> tools/list round-trip succeeds", async () => {
    const initRes = await postJSON(harness.url, initializeBody(1));
    expect(initRes.status).toBe(200);

    const sessionId = initRes.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("expected mcp-session-id header");

    // Consume the initialize response body so the stream closes.
    await initRes.text();

    const listRes = await postJSON(
      harness.url,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
      sessionId
    );
    expect(listRes.status).toBe(200);

    const listText = await listRes.text();
    // Response may be JSON or SSE-framed; either way the "ping" tool name
    // we registered in startTestServer() must appear in the payload.
    expect(listText).toContain("ping");
  });

  test("JSON-RPC batch containing only an initialize request creates a session (batch-initialize acceptance)", async () => {
    // A JSON-RPC batch whose sole element is initialize must be routed to the
    // new-session branch, not rejected with 400. The MCP SDK itself enforces that
    // initialize must be the only message in a batch, so we send [initializeBody].
    const batchBody = [initializeBody(1)];
    const res = await postJSON(harness.url, batchBody);
    // Batch-initialize must be accepted as a new-session request
    expect(res.status).toBe(200);
    const sessionId = res.headers.get("mcp-session-id");
    if (!sessionId) throw new Error("expected mcp-session-id header on batch initialize response");

    const body = await res.text();
    // Initialize response (id:1) must appear in the batch response
    expect(body).toContain('"id":1');
  });

  test("two concurrent initialize calls produce distinct session ids and independent tools/list responses", async () => {
    const [r1, r2] = await Promise.all([
      postJSON(harness.url, initializeBody(1)),
      postJSON(harness.url, initializeBody(1)),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const s1 = r1.headers.get("mcp-session-id");
    const s2 = r2.headers.get("mcp-session-id");
    if (!s1 || !s2) throw new Error("expected mcp-session-id header on both responses");
    expect(s1).not.toBe(s2);

    await Promise.all([r1.text(), r2.text()]);

    const [l1, l2] = await Promise.all([
      postJSON(harness.url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, s1),
      postJSON(harness.url, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, s2),
    ]);

    expect(l1.status).toBe(200);
    expect(l2.status).toBe(200);

    const [t1, t2] = await Promise.all([l1.text(), l2.text()]);
    expect(t1).toContain("ping");
    expect(t2).toContain("ping");
  });
});
