#!/usr/bin/env bun
/**
 * `/memories` table column non-overlap, verified in a real browser (mt#4762
 * PR #3492 R2).
 *
 * The component suite runs under happy-dom, which has no layout engine: every
 * `getBoundingClientRect()` reads all-zero, so a test asserting "the Created
 * cell is not covered by the Tags cell" cannot be written there — the closest
 * a happy-dom test can get is asserting the Tailwind width class on the tags
 * container, which is exactly the surrogate that shipped this defect. The
 * tags column was `w-8` (32px) with no `overflow-hidden` and no per-chip
 * `max-w`, so a real tag ("memory-hygiene" alone renders ~90px at this font
 * size) overflowed its box and painted over the Created cell immediately to
 * its left — every unit/component test stayed green (2657 pass) and the bot
 * review APPROVED, because none of them render real CSS layout. This script
 * closes that gap by measuring the real box model and the real paint order.
 *
 * Two independent assertions per row, not one, because they catch different
 * failure shapes:
 *
 *   1. **Box non-overlap** — the tags cell's left edge is at or to the right
 *      of the Created cell's right edge. This is the direct geometric form of
 *      the regression (a `w-8` box whose children overflow leftward).
 *   2. **Paint-order / actual visibility** — `document.elementFromPoint` at
 *      the Created text's own center returns the Created span (or a
 *      descendant of it), not something else. Two boxes can fail to overlap
 *      geometrically and a THIRD element could still be painted on top via
 *      `position`/`z-index`; conversely two boxes can overlap in the DOM's
 *      layout tree while `pointer-events: none` or stacking order means
 *      nothing is actually obscured. Assertion 2 is what "the value is
 *      legible" actually means, and is immune to either mismatch. Assertion 1
 *      is kept alongside it because a failure there names the SHAPE of the
 *      bug (a too-narrow reserved column) that assertion 2 alone would not.
 *
 * The check is run at BOTH viewports the regression was reported at
 * (1440x1000 and 1920x1100) — the coordinator's report confirmed the defect
 * was not a breakpoint artifact, and this script confirms the fix is not one
 * either.
 *
 * Data-dependence: the assertion is only meaningful on a row that actually
 * has tags to overflow. Real memory records overwhelmingly do (mt#4762's own
 * spec: "records average 7.76 tags"), but a script whose pass condition can
 * be satisfied by a data slice with zero tagged rows would be exactly the
 * kind of probe that returns the same verdict whether or not the system is
 * broken (mem#704). So this scans the first `ROWS_TO_SCAN` rows and requires
 * at least one with a non-empty tags cell — if none is found, that is
 * INCOMPLETE (exit 2), never a silent pass.
 *
 * Usage:
 *   bun scripts/verify-memories-table-columns.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3838 bun scripts/verify-memories-table-columns.ts
 *
 * Prerequisites (each CHECKED at startup via the shared preflight — a missing
 * one exits 0 with `SKIP:`, a present-but-slow one exits 2 with
 * `INCOMPLETE:`, never a silent pass; mt#4149):
 *
 *   1. A running cockpit, started WITHOUT `--no-dev-chromium`:
 *
 *        bun run cockpit:build
 *        bun src/cli.ts cockpit start --port=3838
 *
 *      To verify a change not yet on `main`, run this FROM the session
 *      workspace and point `MINSKY_COCKPIT_URL` at that port — a cockpit
 *      started from `main` serves `main`'s build, not yours.
 *
 *   2. A CDP endpoint (default `127.0.0.1:9222`, the shared dev chromium the
 *      cockpit launches — `src/cockpit/dev-chromium.ts`). Override with
 *      `MINSKY_CDP_URL` if driving a separate headless instance.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`).
 *
 * Cost: opens one tab, reads DOM geometry twice (two viewports), closes. No
 * process spawn beyond the CDP tab, no live-model tokens, a few seconds.
 *
 * Sibling: `scripts/verify-cockpit-shell-scroll.ts` (mt#3335/mt#3338), whose
 * CDP plumbing and preflight usage this follows.
 */
import { preflightCockpit } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";

/** How many leading rows to scan looking for at least one with visible tags. */
const ROWS_TO_SCAN = 15;

const NARROW_AT1 = { width: 1440, height: 1000 };
const WIDE = { width: 1920, height: 1100 };

await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

// --- CDP plumbing (shape follows verify-cockpit-shell-scroll.ts) ----------

type CdpResult = { result?: { value?: string }; exceptionDetails?: unknown };

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

async function navigate(ws: WebSocket, url: string): Promise<void> {
  await cdp(ws, "Page.enable");
  await cdp(ws, "Page.navigate", { url });
}

async function waitForRows(ws: WebSocket): Promise<boolean> {
  const DEADLINE_MS = 20_000;
  const started = Date.now();
  while (Date.now() - started < DEADLINE_MS) {
    const count = await evaluate(
      ws,
      `String(document.querySelectorAll('[data-testid="memories-row"]').length)`
    );
    if (Number(count) > 0) return true;
    await sleep(150);
  }
  return false;
}

// --- The measurement -------------------------------------------------------

/**
 * For each of the first ROWS_TO_SCAN rows, read: whether its tags cell has
 * any chip children, the Created cell's rect, the tags cell's rect, and
 * whether elementFromPoint at the Created rect's center resolves inside the
 * Created cell (closest([data-col="created"])).
 *
 * `elementFromPoint` is only meaningful for a point actually inside the
 * viewport — off-screen coordinates return null (or whatever happens to sit
 * under the document at that scroll position) regardless of overlap, which
 * is a fact about the API, not about this page. `inViewport` is computed
 * here (not filtered in TS afterward) so `document.body` sees the exact same
 * center point the assertion below tests against. A row below the fold is
 * SKIPPED for assertion 2, not failed — the fold is not the regression this
 * script checks for, and box non-overlap (assertion 1) still runs on it.
 */
const READ_ROWS = `(() => {
  const rows = Array.from(document.querySelectorAll('[data-testid="memories-row"]')).slice(0, ${ROWS_TO_SCAN});
  return JSON.stringify(rows.map((row, i) => {
    const created = row.querySelector('[data-col="created"]');
    const tags = row.querySelector('[data-col="tags"]');
    if (!created || !tags) return { index: i, hasCells: false };
    const cr = created.getBoundingClientRect();
    const tr = tags.getBoundingClientRect();
    const hasTagChips = tags.children.length > 0;
    const cx = Math.round(cr.left + cr.width / 2);
    const cy = Math.round(cr.top + cr.height / 2);
    const inViewport = cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight;
    const topEl = inViewport ? document.elementFromPoint(cx, cy) : null;
    const coveredByCreated = !!(topEl && topEl.closest('[data-col="created"]'));
    return {
      index: i,
      hasCells: true,
      hasTagChips,
      inViewport,
      createdRect: { left: cr.left, right: cr.right, top: cr.top, bottom: cr.bottom },
      tagsRect: { left: tr.left, right: tr.right, top: tr.top, bottom: tr.bottom },
      createdVisibleAtCenter: coveredByCreated,
    };
  }));
})()`;

interface RowMeasurement {
  index: number;
  hasCells: boolean;
  hasTagChips?: boolean;
  /** False for a row below the fold — elementFromPoint is not meaningful there. */
  inViewport?: boolean;
  createdRect?: { left: number; right: number; top: number; bottom: number };
  tagsRect?: { left: number; right: number; top: number; bottom: number };
  createdVisibleAtCenter?: boolean;
}

/** 1px slack for sub-pixel rounding, matching the shell-scroll script's convention. */
const SLACK_PX = 1;

async function checkViewport(
  ws: WebSocket,
  label: string,
  viewport: { width: number; height: number },
  failures: string[]
): Promise<void> {
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Reload so the new viewport is in effect before the first layout read —
  // Tailwind's `lg:` breakpoint (the tags/accesses columns) is evaluated at
  // load/resize, and a bare metrics override without a reflow trigger can be
  // read against stale layout on some Chrome versions.
  await navigate(ws, `${COCKPIT}/memories`);
  if (!(await waitForRows(ws))) {
    failures.push(`${label}: no [data-testid="memories-row"] rendered within 20s`);
    return;
  }
  // Let the initial data fetch's re-render (server-driven mode: URL state ->
  // query -> pageItems) settle before reading geometry.
  await sleep(500);

  const rows = JSON.parse(await evaluate(ws, READ_ROWS)) as RowMeasurement[];
  const withTags = rows.filter((r) => r.hasCells && r.hasTagChips);

  if (withTags.length === 0) {
    failures.push(
      `${label}: none of the first ${ROWS_TO_SCAN} rows had any tag chips — cannot exercise the ` +
        `overlap this script checks for (data-dependent; not a pass)`
    );
    return;
  }

  console.log(`${label}: ${withTags.length}/${rows.length} scanned rows have tag chips`);

  const withTagsInViewport = withTags.filter((r) => r.inViewport);
  if (withTagsInViewport.length === 0) {
    failures.push(
      `${label}: no tagged row among the first ${ROWS_TO_SCAN} is inside the viewport — cannot ` +
        `run the paint-order assertion (data/layout-dependent; not a pass)`
    );
  }

  for (const row of withTags) {
    const { createdRect: cr, tagsRect: tr } = row;
    if (!cr || !tr) continue;

    // Assertion 1: box non-overlap — tags starts at/after Created ends.
    // Geometrically valid regardless of scroll position, so this runs for
    // every tagged row, on- or off-screen.
    if (tr.left < cr.right - SLACK_PX) {
      failures.push(
        `${label} row ${row.index}: tags cell (left=${tr.left.toFixed(1)}) starts before the ` +
          `Created cell ends (right=${cr.right.toFixed(1)}) — boxes overlap by ` +
          `${(cr.right - tr.left).toFixed(1)}px`
      );
    }

    // Assertion 2: paint order — the Created text's own center is actually
    // topmost-painted as part of the Created cell, not obscured by anything
    // (the tags cell included) stacked above it. Only meaningful on-screen;
    // `elementFromPoint` for a below-the-fold row answers a different
    // question (what's under the cursor at that pixel with the page
    // scrolled to the top) and is skipped rather than asserted on.
    if (row.inViewport && !row.createdVisibleAtCenter) {
      failures.push(
        `${label} row ${row.index}: elementFromPoint at the Created cell's center did not resolve ` +
          `inside the Created cell — something is painted on top of it`
      );
    }
  }
}

// --- Run -------------------------------------------------------------------

const failures: string[] = [];
const teardown: Array<() => Promise<unknown>> = [];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

let ws: WebSocket;
try {
  const newRes = await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" });
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

try {
  await cdp(ws, "Runtime.enable");
  await checkViewport(ws, "1440x1000 (AT1)", NARROW_AT1, failures);
  await checkViewport(ws, "1920x1100 (reported regression width)", WIDE, failures);
} catch (err) {
  failures.push(`measurement error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await teardownAll();
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} column-overlap assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  "\nPASS: the Tags column never overlaps the Created column, at 1440x1000 and 1920x1100."
);
