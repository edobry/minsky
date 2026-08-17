#!/usr/bin/env bun
/**
 * The `/interceptors` axes + family filters, verified in a real browser (mt#4056).
 *
 * The component suite proves `FamilyChips` renders two different strings when
 * handed two fixtures. It cannot prove the SHIPPED page reaches that component
 * with real catalog data: the fixtures are hand-built, and a payload whose new
 * fields never survived the generator, the widget's row validation, or the
 * TanStack cache would still satisfy every one of those tests. This script
 * closes that gap by reading the rendered DOM of the actual route.
 *
 * Assertions:
 *   1. The catalog renders rows at all, and the family-state summary is present
 *      — so the new payload survived generation, validation and fetch.
 *   2. Every rendered row carries an axis strip (a value or an explicit gap
 *      marker on each axis) — the AT1 invariant, observed rather than inferred.
 *   3. Both zero-family states appear in the REAL corpus, and their markers are
 *      DIFFERENT strings (AT3). Asserted against live data rather than
 *      fixtures, which is the whole point of this script: the two classes
 *      genuinely coexist in the shipped catalog (8 out-of-model, 6
 *      unclassified at authoring time), so this cannot pass vacuously on a
 *      corpus that happens to contain only one of them — it fails if either
 *      class is missing.
 *   4. A family facet actually narrows the list, and every surviving row's
 *      chips claim that family (AT2).
 *
 * It also writes a PNG so the render path has an artifact a reader can open
 * (mt#2421) rather than only an inward-facing assertion.
 *
 * Usage:
 *   bun scripts/verify-interceptors-axes-render.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3839 bun scripts/verify-interceptors-axes-render.ts
 *
 * Prerequisites (each is CHECKED at startup — a missing one exits 0 with a
 * `SKIP:` line, so this is safe to run unattended. A prerequisite that is
 * PRESENT but too slow to answer is a DIFFERENT outcome: `INCOMPLETE:` and
 * exit 2, never a silent 0 — mt#4149):
 *
 *   1. A running cockpit, started WITHOUT `--no-dev-chromium`, and built from
 *      THIS worktree (a cockpit started from `main` serves `main`'s bundle):
 *
 *        bun run cockpit:build
 *        bun src/cli.ts cockpit start --port=3839
 *
 *   2. A CDP endpoint at `127.0.0.1:9222` — the shared dev chromium the cockpit
 *      launches. Check with `curl -s localhost:9222/json/version`.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`),
 * `MINSKY_SCREENSHOT_PATH` (default `/tmp/interceptors-axes.png`).
 *
 * Exits non-zero only on a real behavioral failure. CDP shape follows
 * `scripts/verify-cockpit-shell-scroll.ts` (mt#3338).
 */
import { writeFileSync } from "node:fs";
import { preflightCockpit } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const SCREENSHOT = process.env["MINSKY_SCREENSHOT_PATH"] ?? "/tmp/interceptors-axes.png";
/** The guard-facet view, written beside the default one. */
const FILTERED_SCREENSHOT = `${SCREENSHOT.replace(/\.png$/, "")}-guard-filtered.png`;
const ROUTE = `${COCKPIT}/interceptors`;

const VIEWPORT = { width: 1280, height: 1400 };
/** Ceiling on the grown capture viewport, so a runaway page cannot OOM the tab. */
const MAX_CAPTURE_HEIGHT_PX = 20_000;

// --- Prerequisites -------------------------------------------------------

/**
 * ABSENT, SLOW and WRONG-SERVICE are three different answers (mt#4149), and the
 * shared preflight keeps them apart: a missing cockpit is a `SKIP:` + exit 0, a
 * present-but-over-budget one exits non-zero rather than printing the same line,
 * and `/api/health`'s `service` field is asserted rather than a bare 200.
 */
await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

// --- CDP plumbing (shape follows verify-cockpit-shell-scroll.ts) ----------

type CdpResult = {
  result?: { value?: string };
  data?: string;
  exceptionDetails?: unknown;
};

let msgId = 0;
function cdp(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {}
): Promise<CdpResult> {
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

async function evaluate(ws: WebSocket, expression: string): Promise<string> {
  const r = await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value ?? "";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Write a full-page PNG.
 *
 * Non-fatal by design: the behavioral assertions are the check and the PNG is
 * the artifact, so losing the artifact must not mask a passing verification —
 * nor turn a real failure into a screenshot error.
 */
async function screenshot(path: string, label: string): Promise<void> {
  try {
    // Grow the viewport to the full content height before capturing.
    // `captureBeyondViewport` alone does NOT do this — measured on this page,
    // it returned exactly the viewport (2560x2800 for a 93-row list), so the
    // artifact silently showed only the top of the corpus and none of the
    // zero-family markers, which live in the trailing strata.
    // Measure `<main>`, NOT `documentElement`: the cockpit shell root is
    // `h-screen overflow-hidden` and `<main>` is the scroll container, so the
    // document's own scrollHeight is just the viewport height (measured: 1400
    // for a 93-row list) and growing to it changes nothing.
    const height = Number(
      await evaluate(
        ws,
        `String(Math.max(
           document.querySelector("main")?.scrollHeight ?? 0,
           document.documentElement.scrollHeight
         ))`
      )
    );
    if (Number.isFinite(height) && height > 0) {
      await cdp(ws, "Emulation.setDeviceMetricsOverride", {
        width: VIEWPORT.width,
        height: Math.min(height + 40, MAX_CAPTURE_HEIGHT_PX),
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(300);
    }
    const shot = await cdp(ws, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    if (shot.data) {
      writeFileSync(path, Buffer.from(shot.data, "base64"));
      console.log(`screenshot    : ${path} (${label})`);
    }
  } catch (err) {
    console.log(
      `screenshot    : ${label} unavailable (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

// --- In-page expressions -------------------------------------------------

const READ = `(() => {
  const rows = [...document.querySelectorAll('[data-testid="interceptor-row"]')];
  const text = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent : null;
  };
  return JSON.stringify({
    rowCount: rows.length,
    summary: text('[data-testid="interceptors-family-state-summary"]'),
    // Rows whose axis strip is missing entirely — the AT1 violation.
    rowsWithoutAxes: rows.filter((r) => !r.querySelector('[data-testid="interceptor-axes"]')).length,
    outOfModel: text('[data-testid="interceptor-family-out-of-model"]'),
    unclassified: text('[data-testid="interceptor-family-unclassified"]'),
    outOfModelCount: document.querySelectorAll('[data-testid="interceptor-family-out-of-model"]').length,
    unclassifiedCount: document.querySelectorAll('[data-testid="interceptor-family-unclassified"]').length,
    // Every row's rendered family chips, for the facet check below.
    familyChips: rows.map((r) => {
      const c = r.querySelector('[data-testid="interceptor-family-classified"]');
      return c ? c.textContent : null;
    }),
  });
})()`;

/** Drive the family facet via its underlying Radix trigger. */
const SELECT_GUARD_FAMILY = `(() => {
  const trigger = document.querySelector('[data-testid="interceptors-family-filter"]');
  if (!trigger) return "no-trigger";
  trigger.click();
  return "opened";
})()`;

const CLICK_GUARD_OPTION = `(() => {
  const opts = [...document.querySelectorAll('[role="option"]')];
  const guard = opts.find((o) => (o.textContent || "").startsWith("guard"));
  if (!guard) return "no-option:" + opts.map((o) => o.textContent).join("|");
  guard.click();
  return "clicked";
})()`;

async function waitForRows(ws: WebSocket): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const raw = await evaluate(ws, READ);
    const state = JSON.parse(raw || "{}") as { rowCount?: number };
    if ((state.rowCount ?? 0) > 0) return state.rowCount ?? 0;
    await sleep(500);
  }
  return 0;
}

// --- Run -----------------------------------------------------------------

const failures: string[] = [];
const teardown: Array<() => Promise<unknown>> = [];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

let ws: WebSocket;
try {
  const newRes = await fetch(`${CDP}/json/new?${encodeURIComponent(ROUTE)}`, { method: "PUT" });
  const target = (await newRes.json()) as { id: string; webSocketDebuggerUrl: string };
  teardown.push(() => fetch(`${CDP}/json/close/${target.id}`));
  ws = new WebSocket(target.webSocketDebuggerUrl);
  teardown.push(async () => ws.close());
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("CDP socket did not open within 15s")), 15_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      res();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      rej(new Error("CDP socket failed"));
    });
  });
} catch (err) {
  await teardownAll();
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

await cdp(ws, "Emulation.setDeviceMetricsOverride", {
  width: VIEWPORT.width,
  height: VIEWPORT.height,
  deviceScaleFactor: 1,
  mobile: false,
});

const rowCount = await waitForRows(ws);
if (rowCount === 0) {
  await teardownAll();
  console.error(`FAIL: ${ROUTE} rendered no interceptor rows within 20s`);
  process.exit(1);
}

const state = JSON.parse(await evaluate(ws, READ)) as {
  rowCount: number;
  summary: string | null;
  rowsWithoutAxes: number;
  outOfModel: string | null;
  unclassified: string | null;
  outOfModelCount: number;
  unclassifiedCount: number;
  familyChips: Array<string | null>;
};

console.log(`\nrendered rows : ${state.rowCount}`);
console.log(`summary       : ${state.summary?.replace(/\s+/g, " ").trim()}`);

// (1) the new payload reached the page
if (!state.summary) failures.push("the family-state summary did not render");

// (2) AT1 — every row carries an axis strip
if (state.rowsWithoutAxes > 0) {
  failures.push(`${state.rowsWithoutAxes} of ${state.rowCount} rows rendered no axis strip`);
}

// (3) AT3 — both zero-family states present in the REAL corpus, and DIFFERENT
if (state.outOfModelCount === 0) {
  failures.push("no out-of-model entity rendered — cannot demonstrate the distinction");
}
if (state.unclassifiedCount === 0) {
  failures.push("no unclassified entity rendered — cannot demonstrate the distinction");
}
if (state.outOfModel !== null && state.unclassified !== null) {
  if (state.outOfModel === state.unclassified) {
    failures.push(
      `the two zero-family markers render identically ("${state.outOfModel}") — the conflation AT3 forbids`
    );
  } else {
    console.log(`out-of-model  : "${state.outOfModel}" (${state.outOfModelCount} rows)`);
    console.log(`unclassified  : "${state.unclassified}" (${state.unclassifiedCount} rows)`);
  }
}

// Capture the DEFAULT view before filtering — the artifact should show the
// whole corpus including both zero-family markers, not a narrowed slice.
await screenshot(SCREENSHOT, "unfiltered");

// (4) AT2 — the family facet narrows, and survivors claim the family
await evaluate(ws, SELECT_GUARD_FAMILY);
await sleep(400);
const clicked = await evaluate(ws, CLICK_GUARD_OPTION);
if (clicked !== "clicked") {
  failures.push(`could not drive the family facet: ${clicked}`);
} else {
  await sleep(600);
  const filtered = JSON.parse(await evaluate(ws, READ)) as {
    rowCount: number;
    familyChips: Array<string | null>;
  };
  console.log(`guard filter  : ${filtered.rowCount} of ${state.rowCount} rows`);
  if (filtered.rowCount === 0) {
    failures.push("the guard facet matched nothing");
  } else if (filtered.rowCount >= state.rowCount) {
    failures.push(
      `the guard facet did not narrow the list (${filtered.rowCount} of ${state.rowCount})`
    );
  }
  const notGuard = filtered.familyChips.filter((c) => c === null || !c.includes("guard")).length;
  if (notGuard > 0) {
    failures.push(`${notGuard} rows survived the guard facet without claiming the guard family`);
  }
}

await screenshot(FILTERED_SCREENSHOT, "guard-filtered");

await teardownAll();

if (failures.length > 0) {
  console.error(`\nFAILED\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nPASS — axes render, both zero-family states are distinguishable, facets narrow");
