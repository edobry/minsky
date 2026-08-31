#!/usr/bin/env bun
/**
 * Capture the `/memories` page for render-path evidence (mt#4767, mt#2421).
 *
 * Drives the shared dev chromium over raw CDP — the same plumbing shape
 * `verify-memories-table-columns.ts` (mt#4762) uses, and the same browser the
 * cockpit launches (`src/cockpit/dev-chromium.ts`, port 9222).
 *
 * Captures the page in its default state and in each worklist/view the task
 * adds, UNCROPPED at a realistic viewport. The point is that the principal
 * judges whether it looks right — `humility.mdc §Subjective quality is not
 * yours to certify` — so this asserts nothing about appearance. It only
 * confirms each view RENDERED (a non-trivial DOM under the expected testid)
 * before the shutter, which is the mem#1148 failure it exists to avoid: a
 * capture taken before the state settled looks exactly like a correct one.
 *
 * Usage:
 *   bun scripts/capture-memories-render.ts [--cockpit http://127.0.0.1:4767] [--out docs/evidence/mt-4767]
 *
 * Exit codes: 0 captured all views · 1 a view failed to render · 2 could not run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INCOMPLETE = 2;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const COCKPIT = arg("cockpit", "http://127.0.0.1:4767");
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const OUT = arg("out", "docs/evidence/mt-4767");
const VIEWPORT = { width: 1440, height: 900 };

/** Each view: a URL suffix, a filename, and the testid that proves it rendered. */
const VIEWS = [
  { name: "01-default", path: "/memories", ready: "memories-curation" },
  { name: "02-untagged", path: "/memories?mem_f_untagged=true", ready: "memories-curation" },
  {
    name: "03-superseded",
    path: "/memories?mem_f_onlySuperseded=true",
    ready: "memories-curation",
  },
  { name: "04-duplicates", path: "/memories?mem_view=duplicates", ready: "memories-duplicates" },
];

let msgId = 0;
function cdp(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.removeEventListener("message", onMsg);
      reject(new Error(`CDP ${method} timed out`));
    }, 30_000);
    function onMsg(ev: MessageEvent) {
      const m = JSON.parse(String(ev.data));
      if (m.id !== id || settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws: WebSocket, expression: string): Promise<unknown> {
  const r = (await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown } };
  return r.result?.value;
}

/**
 * Poll until the view's own testid carries real content.
 *
 * Checks `textContent.length`, not mere presence: a mounted-but-empty
 * container is exactly what a capture-too-early produces, and it photographs
 * as a plausible page (mem#1148 — the capture records STATE, not the action
 * that set it up).
 */
async function waitForRender(ws: WebSocket, testid: string): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const len = await evaluate(
      ws,
      `(document.querySelector('[data-testid="${testid}"]')?.textContent ?? '').trim().length`
    );
    if (typeof len === "number" && len > 20) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main(): Promise<number> {
  try {
    const health = await fetch(`${COCKPIT}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) throw new Error(`cockpit /health returned ${health.status}`);
  } catch (err) {
    console.error(`SKIP: cockpit not reachable at ${COCKPIT}: ${String(err)}`);
    return EXIT_INCOMPLETE;
  }

  let wsUrl: string;
  try {
    const res = await fetch(`${CDP}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(5_000),
    });
    const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
    wsUrl = target.webSocketDebuggerUrl;
    process.on("exit", () => void fetch(`${CDP}/json/close/${target.id}`, { method: "PUT" }));
  } catch (err) {
    console.error(`SKIP: no CDP endpoint at ${CDP}: ${String(err)}`);
    return EXIT_INCOMPLETE;
  }

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("CDP socket did not open within 15s")), 15_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      res();
    });
    ws.addEventListener("error", () => rej(new Error("CDP socket failed")));
  });

  await cdp(ws, "Page.enable");
  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 2,
    mobile: false,
  });

  mkdirSync(OUT, { recursive: true });
  let failures = 0;

  for (const view of VIEWS) {
    const url = `${COCKPIT}${view.path}`;
    await cdp(ws, "Page.navigate", { url });
    const rendered = await waitForRender(ws, view.ready);
    if (!rendered) {
      console.error(`[FAIL] ${view.name} — [data-testid="${view.ready}"] never carried content`);
      failures++;
      continue;
    }
    // Settle one animation frame past the readiness check so in-flight
    // transitions are not caught mid-way.
    await new Promise((r) => setTimeout(r, 600));

    const shot = (await cdp(ws, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    })) as { data: string };
    const file = join(OUT, `${view.name}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(`[OK]   ${view.name} -> ${file}  (${url})`);
  }

  ws.close();
  return failures === 0 ? EXIT_PASS : EXIT_FAIL;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("SKIP: capture could not complete:", err);
      process.exit(EXIT_INCOMPLETE);
    });
}
