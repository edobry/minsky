import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { createCockpitServer } from "./server";

// mt#2538: createCockpitServer generates/persists a real bearer token on
// first use unless overridden — pass a fixed test token so this GET-only
// test never touches ~/.local/state/minsky/cockpit-token.
const TEST_TOKEN = "test-server-projects-token";

async function startTestServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = createCockpitServer({ overrideToken: TEST_TOKEN });
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

describe("GET /api/projects (mt#2418)", () => {
  let closeServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
  });

  test("returns JSON with a projects array (empty when no SQL db available)", async () => {
    const { url, close } = await startTestServer();
    closeServer = close;

    const res = await fetch(`${url}/api/projects`);
    // No SQL-capable persistence provider in this test process -> degrades
    // to 200 + empty list rather than 503 (§ route docstring: a
    // single-project/non-Postgres deployment has no projects table at all).
    expect(res.status).toBe(200);

    const body = (await res.json()) as { projects?: unknown };
    expect(body).toHaveProperty("projects");
    expect(Array.isArray(body.projects)).toBe(true);
  });
});
