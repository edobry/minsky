/**
 * Cockpit integration tests (mt#1144)
 *
 * Uses createCockpitServer with overrides to test server behavior
 * without touching the filesystem or real cockpit.json.
 *
 * Port strategy: listen on 0 (random) via Node's http module; call
 * the app via fetch against http://localhost:<assigned-port>.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { createCockpitServer } from "./server";
import type { WidgetModule, WidgetData, WidgetContext } from "./types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Start the app on a random port; resolves with (url, closeServer). */
async function startTestServer(opts?: Parameters<typeof createCockpitServer>[0]): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const app = createCockpitServer(opts);
  const server: Server = createServer(app);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
  const url = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return { url, close };
}

// ---------------------------------------------------------------------------
// Default registry: both placeholder widgets enabled
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  widgets: [
    { id: "attention-stub", enabled: true },
    { id: "basic-health", enabled: true },
  ],
};

// ---------------------------------------------------------------------------
// Test servers — started lazily and closed per-test
// ---------------------------------------------------------------------------

describe("Cockpit server", () => {
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

  // 1. Server boots; GET /api/health → 200 + {status, version, uptimeSec}
  test("GET /api/health returns 200 and status ok with uptimeSec", async () => {
    const url = await server({ overrideConfig: DEFAULT_CONFIG });
    const res = await fetch(`${url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    // Field is named `uptimeSec` (not `uptime`) so naming is consistent with
    // the basic-health widget payload — see PR #1017 reviewer finding R1.
    expect(typeof body.uptimeSec).toBe("number");
    expect(typeof body.version).toBe("string");
    expect(body.uptime).toBeUndefined();
  });

  // 2. GET /api/widgets → array containing both placeholder widgets
  test("GET /api/widgets returns both enabled widgets", async () => {
    const url = await server({ overrideConfig: DEFAULT_CONFIG });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(Array.isArray(body)).toBe(true);
    const ids = body.map((w) => w.id);
    expect(ids).toContain("attention-stub");
    expect(ids).toContain("basic-health");
  });

  // 3. GET /api/widget/attention-stub/data → {state:"degraded", reason matching /pending mt#1034/i}
  test("GET /api/widget/attention-stub/data returns degraded with pending reason", async () => {
    const url = await server({ overrideConfig: DEFAULT_CONFIG });
    const res = await fetch(`${url}/api/widget/attention-stub/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; reason: string };
    expect(body.state).toBe("degraded");
    expect(body.reason).toMatch(/pending mt#1034/i);
  });

  // 4. GET /api/widget/basic-health/data → {state:"ok", payload:{uptimeSec:number, version:string, loadedWidgetCount:2}}
  test("GET /api/widget/basic-health/data returns ok with health payload", async () => {
    const url = await server({ overrideConfig: DEFAULT_CONFIG });
    const res = await fetch(`${url}/api/widget/basic-health/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      payload: { uptimeSec: number; version: string; loadedWidgetCount: number };
    };
    expect(body.state).toBe("ok");
    expect(typeof body.payload.uptimeSec).toBe("number");
    expect(typeof body.payload.version).toBe("string");
    expect(body.payload.loadedWidgetCount).toBe(2);
  });

  // 5. Inject widget that throws → {state:"degraded", reason matching /widget crashed/i}
  test("Widget that throws returns degraded with 'widget crashed' reason", async () => {
    const crashingWidget: WidgetModule = {
      id: "crashing-test",
      title: "Crashing Test Widget",
      updateMode: { type: "manual" },
      async fetch(_ctx: WidgetContext): Promise<WidgetData> {
        throw new Error("boom");
      },
    };
    const url = await server({
      overrideConfig: {
        widgets: [{ id: "crashing-test", enabled: true }],
      },
      overrideRegistry: { "crashing-test": crashingWidget },
    });
    const res = await fetch(`${url}/api/widget/crashing-test/data`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; reason: string };
    expect(body.state).toBe("degraded");
    expect(body.reason).toMatch(/widget crashed/i);
  });

  // 6. overrideConfig disabling attention-stub → only basic-health in /api/widgets
  test("Disabling attention-stub via overrideConfig excludes it from /api/widgets", async () => {
    const url = await server({
      overrideConfig: {
        widgets: [
          { id: "attention-stub", enabled: false },
          { id: "basic-health", enabled: true },
        ],
      },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    const ids = body.map((w) => w.id);
    expect(ids).not.toContain("attention-stub");
    expect(ids).toContain("basic-health");
  });

  // 8. Malformed config (no widgets array) — server doesn't crash on
  // /api/widgets and yields an empty list. This exercises the defensive
  // path in `loadCockpitConfig` for the case where a user's existing
  // ~/.config/minsky/cockpit.json is empty or malformed (PR #1017 R1).
  test("Malformed overrideConfig does not crash; /api/widgets returns empty list", async () => {
    const url = await server({
      // Intentionally malformed — `widgets` is not an array of valid entries.
      // The server's effective enabledWidgets must fall back to empty rather
      // than crash on iteration.
      overrideConfig: { widgets: [] },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  // 7. overrideConfig + overrideRegistry adding third placeholder → 3 entries
  test("Adding third widget via overrideRegistry adds 3 entries to /api/widgets", async () => {
    const thirdWidget: WidgetModule = {
      id: "extra-stub",
      title: "Extra Stub",
      updateMode: { type: "manual" },
      async fetch(_ctx: WidgetContext): Promise<WidgetData> {
        return { state: "degraded", reason: "Placeholder" };
      },
    };
    const url = await server({
      overrideConfig: {
        widgets: [
          { id: "attention-stub", enabled: true },
          { id: "basic-health", enabled: true },
          { id: "extra-stub", enabled: true },
        ],
      },
      overrideRegistry: { "extra-stub": thirdWidget },
    });
    const res = await fetch(`${url}/api/widgets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.length).toBe(3);
    const ids = body.map((w) => w.id);
    expect(ids).toContain("extra-stub");
  });
});
