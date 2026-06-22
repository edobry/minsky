import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { createCockpitServer } from "./server";

async function startTestServer(opts?: Parameters<typeof createCockpitServer>[0]): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = createCockpitServer(opts);
  const server: Server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected address");

  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

describe("GET /api/tasks (mt#1917)", () => {
  let closeServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
  });

  test("returns JSON with tasks array or 503 when DB unavailable", async () => {
    const { url, close } = await startTestServer({});
    closeServer = close;

    const res = await fetch(`${url}/api/tasks`);
    // Without a real DB, the task service returns null → 503
    // OR init may succeed with an empty list → 200
    expect([200, 503]).toContain(res.status);

    const body = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) {
      expect(body).toHaveProperty("tasks");
      expect(Array.isArray(body["tasks"])).toBe(true);
    } else {
      expect(body).toHaveProperty("error");
    }
  });
});

describe("GET /api/tasks/ids (mt#2518 R5)", () => {
  let closeServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
  });

  test("returns JSON with ids array or 503 when DB unavailable", async () => {
    const { url, close } = await startTestServer({});
    closeServer = close;

    const res = await fetch(`${url}/api/tasks/ids`);
    // Without a real DB, the task service returns null → 503
    // OR init may succeed with an empty list → 200
    expect([200, 503]).toContain(res.status);

    const body = (await res.json()) as Record<string, unknown>;
    if (res.status === 200) {
      expect(body).toHaveProperty("ids");
      expect(Array.isArray(body["ids"])).toBe(true);
    } else {
      expect(body).toHaveProperty("error");
    }
  });

  test("/api/tasks/ids is not caught by /api/tasks/:id (route ordering)", async () => {
    const { url, close } = await startTestServer({});
    closeServer = close;

    const res = await fetch(`${url}/api/tasks/ids`);
    const body = (await res.json()) as Record<string, unknown>;

    // The ids endpoint should return { ids } or 503, NOT a task-detail 404
    // that would have { error: "..." } with status 404.
    if (res.status === 200) {
      expect(body).toHaveProperty("ids");
      expect(Array.isArray(body["ids"])).toBe(true);
    } else {
      // 503 (service unavailable) is acceptable; 404 is not
      expect(res.status).toBe(503);
      expect(body).toHaveProperty("error");
    }
  });
});
