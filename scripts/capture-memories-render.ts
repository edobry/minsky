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
/** Every view names the testid that proves it actually rendered. */
interface CaptureView {
  name: string;
  path: string;
  ready: string;
  /** Default true. Set false for a route whose document is narrower than the
   * viewport — see the capture call for why that matters. */
  fullDocument?: boolean;
}

const VIEWS: CaptureView[] = [
  { name: "01-default", path: "/memories", ready: "memories-curation" },
  { name: "02-untagged", path: "/memories?mem_f_untagged=true", ready: "memories-curation" },
  {
    name: "03-superseded",
    path: "/memories?mem_f_onlySuperseded=true",
    ready: "memories-curation",
  },
  { name: "04-duplicates", path: "/memories?mem_view=duplicates", ready: "memories-duplicates" },
  // mt#4787: the detail page's "Similar Memories" list, where the score was
  // rendered inverted (closest match showing the smallest percentage). The id
  // is `mem#1344`, the record the defect was originally filed against, so the
  // capture is directly comparable to the screenshot in that task's Summary.
  // Override with --memory-id when that record is gone.
  {
    name: "05-memory-detail-similarity",
    path: `/memory/${arg("memory-id", "c0073124-ff2e-46eb-b0e1-bc3aef3e5a07")}`,
    ready: "memory-similar",
    fullDocument: false,
  },
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

/**
 * Wait until the page's layout stops moving (mt#4787).
 *
 * Readiness says the CONTENT is there; it says nothing about whether the page
 * has finished ANIMATING. `/memory/:id` is a slide-in drawer, and a capture
 * during its transform produces a scaled image that is indistinguishable from
 * a correct screenshot of a zoomed page.
 *
 * Samples the document's scroll dimensions plus the body's computed transform
 * until two consecutive reads agree, then one more frame. Bounded, so a page
 * that never settles still yields a capture rather than hanging.
 */
async function settleGeometry(ws: WebSocket): Promise<void> {
  const probe = `JSON.stringify([
    document.documentElement.scrollWidth,
    document.documentElement.scrollHeight,
    getComputedStyle(document.body).transform,
    (document.querySelector('[data-testid="memory-similar"]')?.getBoundingClientRect().top ?? 0) | 0
  ])`;
  let previous = "";
  for (let i = 0; i < 20; i++) {
    const current = await evaluate(ws, probe);
    if (typeof current === "string" && current === previous) {
      await new Promise((r) => setTimeout(r, 250));
      return;
    }
    previous = typeof current === "string" ? current : "";
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Readiness is by TESTID, never by visible text (mt#4787).
 *
 * A text probe was tried here and rejected on evidence: the detail page's
 * heading is `Similar Memories` in the source and renders through
 * `class="uppercase"`, so `innerText` yields `SIMILAR MEMORIES` and a probe
 * written against the source casing never matches. The section was rendering
 * correctly the whole time. CSS-transformed text is a property of the
 * STYLESHEET, not of the markup you are reading, which makes text a probe whose
 * failure looks exactly like the content being absent.
 */

async function main(): Promise<number> {
  try {
    const health = await fetch(`${COCKPIT}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) throw new Error(`cockpit /health returned ${health.status}`);
  } catch (err) {
    console.error(`SKIP: cockpit not reachable at ${COCKPIT}: ${String(err)}`);
    return EXIT_INCOMPLETE;
  }

  let wsUrl: string;
  let targetId: string | undefined;
  try {
    const res = await fetch(`${CDP}/json/new?about:blank`, {
      method: "PUT",
      signal: AbortSignal.timeout(5_000),
    });
    const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
    wsUrl = target.webSocketDebuggerUrl;
    // Closed explicitly and AWAITED at the end of main(), not in a
    // `process.on("exit")` handler (mt#4787): an exit handler cannot complete
    // an async fetch, so every run leaked its tab into the SHARED dev chromium.
    // Three had accumulated before this was noticed, and the symptom was
    // captures that passed, then passed, then began failing readiness on views
    // that had worked minutes earlier — a cleanup that looked like it ran.
    targetId = target.id;
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
    // Re-assert the viewport per view, not once before the loop (mt#4787):
    // a navigation can land with the override not applied, and the result is a
    // hugely-zoomed capture that still looks like a successful screenshot —
    // exactly the "records state, not the action that set it up" failure
    // mem#1148 describes. Setting it every time costs one CDP call.
    await cdp(ws, "Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp(ws, "Page.navigate", { url });
    const rendered = await waitForRender(ws, view.ready);
    if (!rendered) {
      console.error(`[FAIL] ${view.name} — [data-testid="${view.ready}"] never carried content`);
      failures++;
      continue;
    }
    // Settle past the readiness check so an in-flight transition is not caught
    // mid-way — readiness says the CONTENT exists, not that layout has stopped
    // moving (mem#1148). Replaces a fixed 600ms with an actual observation.
    //
    // Honest note on why this is here: it was added on the theory that a
    // mid-animation capture explained the zoomed `/memory/:id` screenshots. It
    // did NOT — that was `captureBeyondViewport` over a narrow document, fixed
    // separately below, and the zoom reproduced identically with this in place.
    // Kept because waiting on observed geometry is still better than a guessed
    // delay, but it is not the fix for that symptom and should not be cited as
    // one.
    await settleGeometry(ws);

    // A viewport capture shows the top of the page, which for `/memory/:id` is
    // metadata rather than the section this evidence is about. Bring the
    // ready-element into view first, then let the scroll settle.
    if (view.fullDocument === false) {
      await evaluate(
        ws,
        `document.querySelector('[data-testid="${view.ready}"]')
           ?.scrollIntoView({ block: "center" }), true`
      );
      await settleGeometry(ws);
    }

    // `captureBeyondViewport` captures the DOCUMENT's bounds, not the
    // viewport's (mt#4787). For the list views that is what we want — the page
    // is viewport-width and taller, so we get the whole thing. For
    // `/memory/:id` it is actively wrong: that route renders a narrow drawer,
    // so the document is a few hundred px wide and the capture scales it up to
    // fill the image, producing a hugely-zoomed screenshot that still looks
    // like a legitimate one. Views that render narrow opt out and get the
    // viewport instead.
    const shot = (await cdp(ws, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: view.fullDocument !== false,
    })) as { data: string };
    const file = join(OUT, `${view.name}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(`[OK]   ${view.name} -> ${file}  (${url})`);
  }

  ws.close();
  if (targetId) {
    // Awaited, so the tab is actually gone before the process ends.
    await fetch(`${CDP}/json/close/${targetId}`, { method: "PUT" }).catch(() => {
      console.error(
        `WARN: could not close CDP target ${targetId}; it may leak into the shared browser.`
      );
    });
  }
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
