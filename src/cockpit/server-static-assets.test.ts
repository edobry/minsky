/**
 * Static-asset serving contract (mt#2674).
 *
 * After a rebuild replaces the content-hashed chunks, a stale window's
 * dynamic import fetches a chunk path that no longer exists. The server
 * must return a hard 404 for that request — NOT the SPA index.html
 * fallback, which the browser rejects with "'text/html' is not a valid
 * JavaScript MIME type" and the widget error boundary renders as a crash.
 *
 * Mirrors the pattern in server-task-detail.test.ts: real HTTP server on a
 * random port, hit with fetch. Uses overrideWebDistDir so the contract is
 * testable without a real `cockpit:build` output.
 */
/* eslint-disable custom/no-real-fs-in-tests -- express.static serves from the real fs; a temp dist dir IS the contract under test */
import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { createCockpitServer } from "./server";

let distDir: string;
let emptyDistDir: string;

beforeAll(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-dist-"));
  fs.mkdirSync(path.join(distDir, "assets"));
  fs.writeFileSync(path.join(distDir, "assets", "chunk-abc123.js"), "export const ok = true;\n");
  fs.writeFileSync(
    path.join(distDir, "index.html"),
    '<!doctype html><html><body><div id="root"></div></body></html>\n'
  );
  emptyDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "cockpit-dist-empty-"));
});

afterAll(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.rmSync(emptyDistDir, { recursive: true, force: true });
});

async function startTestServer(overrideWebDistDir: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = createCockpitServer({ overrideWebDistDir });
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

describe("static asset serving (mt#2674)", () => {
  let closeServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
  });

  test("existing asset is served with a JavaScript MIME type", async () => {
    const { url, close } = await startTestServer(distDir);
    closeServer = close;

    const res = await fetch(`${url}/assets/chunk-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("javascript");
  });

  test("missing asset returns 404 — never the text/html SPA fallback", async () => {
    const { url, close } = await startTestServer(distDir);
    closeServer = close;

    const res = await fetch(`${url}/assets/chunk-gone-999.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Asset not found");
  });

  test("missing asset 404s even when the assets dir itself is absent", async () => {
    const { url, close } = await startTestServer(emptyDistDir);
    closeServer = close;

    const res = await fetch(`${url}/assets/anything.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  test("SPA routes still serve index.html, with no-cache so reloads see fresh chunk hashes", async () => {
    const { url, close } = await startTestServer(distDir);
    closeServer = close;

    const res = await fetch(`${url}/ask/38b1c0de-0000-0000-0000-000000000000`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(res.headers.get("cache-control") ?? "").toContain("no-cache");
  });

  test("SPA fallback without a built bundle returns the not-built hint, not HTML", async () => {
    const { url, close } = await startTestServer(emptyDistDir);
    closeServer = close;

    const res = await fetch(`${url}/agents`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Cockpit bundle not built");
  });
});
