#!/usr/bin/env bun
/**
 * Peek pane interior layout, verified in a real browser (mt#4123).
 *
 * Every criterion mt#4123 was filed against is GEOMETRIC — "content has visible
 * margins", "exactly one scroll container per pane", "the page behind stays
 * legible" — and none of them can be asserted in the component suite. That suite
 * runs under happy-dom, which has no layout engine: `clientHeight`,
 * `scrollHeight` and `getBoundingClientRect()` all read 0 there (measured
 * mt#3338), so the only thing a component test can pin is the CLASS LIST that
 * produced correct geometry — a surrogate that cannot catch a regression which
 * leaves the classes intact and breaks the layout anyway. `src/cockpit/CLAUDE.md`
 * §"Asserting layout geometry" prescribes exactly this split, and this script is
 * the geometry half.
 *
 * It also closes the gap that let the defect ship. mt#3694 shipped the peek with
 * 12 integration tests, a full-suite pass, a negative control AND a live browser
 * check, and it still looked like this, because every one of those asked a
 * question a badly-laid-out pane answers correctly. These assertions are stated
 * in the units the complaint was made in.
 *
 * ## Assertions
 *
 * At 1440x900 (the desktop case):
 *   1. The pane's content has real horizontal gutters — not flush to the edges.
 *   2. Header and body gutters AGREE. Padding only on the body puts a step in the
 *      pane's left edge; that was a real intermediate state of this task's own
 *      fix (13px vs 17px), caught by looking.
 *   3. Exactly ONE scroll container in the pane, and it is the pane's own body.
 *   4. No descendant carries the nested-scroller SHAPE — a max-height cap plus
 *      its own `overflow: auto`. This is stated structurally rather than as "the
 *      spec block has no cap" so that a DIFFERENT body reintroducing the shape
 *      is caught too.
 *   5. The pane leaves the page a majority column.
 *
 * At 620x900 (the width the principal reported from):
 *   6. The pane takes at most half the viewport, and the page keeps a column
 *      wide enough to read. Before this task the pane was a flat 416px here —
 *      67% of the frame, with the page sliced mid-word.
 *
 * ## Negative control
 *
 * Point `MINSKY_COCKPIT_URL` at a cockpit serving the UNFIXED tree and this
 * script FAILS on assertions 1, 3, 4 and 6 — which is how it was confirmed to be
 * capable of failing rather than merely passing. See the mt#4123 PR body for the
 * recorded run.
 *
 * ## Usage
 *
 *   bun scripts/verify-peek-pane-layout.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3841 bun scripts/verify-peek-pane-layout.ts
 *
 * Prerequisites (each CHECKED at startup — a missing one exits 0 with a `SKIP:`
 * line, so this is safe to run unattended; a present-but-too-slow one is
 * `INCOMPLETE:` and exit 2, never a silent 0):
 *
 *   1. A running cockpit. To verify a change that is not yet on `main`, build
 *      and start it from the SESSION workspace and point `MINSKY_COCKPIT_URL`
 *      at that port — a cockpit started from `main` serves `main`'s build:
 *
 *        bun run cockpit:build
 *        bun src/cli.ts cockpit start --port=3841
 *
 *   2. A CDP endpoint (default `127.0.0.1:9222`, the shared dev chromium). This
 *      opens its own tab and closes it on exit.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`), `MINSKY_PEEK_TASK_ID`
 * (default `mt#4123` — any task page carrying at least one entity ref works).
 *
 * Cost: opens one tab, clicks one link, measures at two viewports, closes.
 * Sibling whose CDP shape this follows: `scripts/verify-cockpit-shell-scroll.ts`.
 */
import { preflightCockpit } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const TASK_ID = process.env["MINSKY_PEEK_TASK_ID"] ?? "mt#4123";

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 620, height: 900 };

/**
 * Thresholds, each tied to the criterion it encodes rather than to a round
 * number (`decision-defaults.mdc §Thresholds`).
 *
 * `MIN_GUTTER_PX`: 8px. The criterion is "no text sits flush against a pane
 * edge", so this only has to separate "there is a gutter" from "there is none";
 * the shipped value is 16px, and pinning 16 here would fail a future 12px
 * redesign that violates nothing.
 *
 * `MAX_PANE_FRACTION_*`: the peek's whole premise is that the page keeps your
 * place, so the page must hold the MAJORITY at every width. Wide is 0.35 (shipped
 * 0.29 at 1440) and narrow 0.5 (shipped 0.45 at 620) — the narrow bound is looser
 * because a proportional pane necessarily claims more of a small frame.
 *
 * `MIN_PAGE_COLUMN_PX`: 300px. Below roughly a phone's width the page behind
 * stops being readable prose and becomes the fragments the report was about.
 */
const MIN_GUTTER_PX = 8;
const MAX_PANE_FRACTION_WIDE = 0.35;
const MAX_PANE_FRACTION_NARROW = 0.5;
const MIN_PAGE_COLUMN_PX = 300;

await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

// --- CDP plumbing (shape follows verify-cockpit-shell-scroll.ts) ---------

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

// --- In-page expressions -------------------------------------------------

/**
 * Open a peek the way an operator does: by clicking an entity ref on the page.
 *
 * Setting `?peek=` directly would be shorter and would verify the RENDERER while
 * saying nothing about the wiring that gets a user there — the half that broke in
 * mt#2398, where every real click 404'd while the renderer itself was fine
 * (`cockpit-design` §"Verifying a render change").
 *
 * Resolves to the outcome so the caller can tell "no ref on this page" (a bad
 * fixture) from "clicked and no pane appeared" (a real failure).
 */
/**
 * Click the first entity ref that belongs to the PAGE, not to an open pane.
 *
 * Scoping matters: the pane's own body renders entity refs too, and an ordinary
 * click REPLACES the last pane — so an unscoped selector can swap the pane's
 * subject out from under the measurement.
 */
const CLICK_PAGE_REF = `(() => {
  const host = document.querySelector('[data-testid="peek-host"]');
  const ref = Array.from(document.querySelectorAll("a[data-entity-ref]"))
    .find((a) => !host || !host.contains(a));
  if (!ref) return "no-entity-ref";
  ref.click();
  return "clicked";
})()`;

/** Count of page-owned entity refs — the readiness signal before clicking. */
const PAGE_REF_COUNT = `(() => {
  const host = document.querySelector('[data-testid="peek-host"]');
  return String(Array.from(document.querySelectorAll("a[data-entity-ref]"))
    .filter((a) => !host || !host.contains(a)).length);
})()`;

/** Is a peek pane up with a rendered body? */
const PEEK_IS_OPEN = `(() => {
  const pane = document.querySelector('[data-testid="peek-pane"]');
  return pane && pane.innerText.length > 200 ? "open" : "closed";
})()`;

type PaneGeometry = {
  present: boolean;
  /** First line of the pane's text, so the log names WHICH entity was measured. */
  subject: string;
  viewportWidth: number;
  paneWidth: number;
  pageColumnPx: number;
  headerGutterPx: number;
  bodyGutterPx: number;
  scrollerCount: number;
  scrollerIsPaneBody: boolean;
  scrollerClasses: string[];
  /** Descendants carrying the nested-scroller shape: a height cap AND own overflow. */
  cappedScrollers: string[];
};

/**
 * Read the pane's box model.
 *
 * Gutters are measured as the RENDERED distance from the pane's border to the
 * first content box, not as a computed `padding` string. Padding is one of
 * several ways a gutter can be produced or destroyed (a margin, a nested wrapper,
 * a negative inset), and the criterion is about where the text actually sits.
 */
const READ_PANE = `(() => {
  const pane = document.querySelector('[data-testid="peek-pane"]');
  if (!pane) return JSON.stringify({ present: false });
  const paneRect = pane.getBoundingClientRect();
  const header = pane.querySelector(":scope > div:first-child");
  const body = pane.querySelector(":scope > div:last-child");
  const leftOf = (el) => {
    const first = el && el.firstElementChild;
    const target = (first && first.firstElementChild) || first;
    return target ? Math.round(target.getBoundingClientRect().left - paneRect.left) : -1;
  };

  const scrollers = Array.from(pane.querySelectorAll("*")).filter((el) => {
    const s = getComputedStyle(el);
    const scrolls = s.overflowY === "auto" || s.overflowY === "scroll";
    return scrolls && el.scrollHeight > el.clientHeight;
  });

  // The nested-scroller SHAPE, independent of which body produced it: a element
  // that both caps its height and owns a scrollbar is a second scrollport inside
  // the pane's, whether or not it happens to be overflowing right now.
  const capped = Array.from(pane.querySelectorAll("*")).filter((el) => {
    const s = getComputedStyle(el);
    const hasCap = s.maxHeight !== "none" && parseFloat(s.maxHeight) > 0;
    const ownsOverflow = s.overflowY === "auto" || s.overflowY === "scroll";
    return hasCap && ownsOverflow;
  });

  return JSON.stringify({
    present: true,
    subject: String(pane.innerText).split("\\n")[0].slice(0, 60),
    viewportWidth: window.innerWidth,
    paneWidth: Math.round(paneRect.width),
    pageColumnPx: Math.round(window.innerWidth - paneRect.width),
    headerGutterPx: leftOf(header),
    bodyGutterPx: leftOf(body),
    scrollerCount: scrollers.length,
    scrollerIsPaneBody: scrollers.length === 1 && scrollers[0] === body,
    scrollerClasses: scrollers.map((e) => String(e.className).slice(0, 80)),
    cappedScrollers: capped.map((e) => String(e.className).slice(0, 80)),
  });
})()`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll an in-page condition from OUTSIDE, one `Runtime.evaluate` per attempt.
 *
 * This is not a style preference. A `Runtime.evaluate` executes against ONE
 * execution context, and a context belongs to ONE document — so an async
 * expression that loops internally stays pinned to whichever document existed
 * when it started. A tab opened via `PUT /json/new` is typically still on the
 * pre-navigation document at that moment, and an in-page loop then polls a
 * document the SPA will never mount into: it waits out its full deadline and
 * reports "the page rendered no entity ref", which reads exactly like a broken
 * fixture. (Cost this task ~15 minutes and two identical failures before the
 * cause was found; the sibling `verify-cockpit-shell-scroll.ts` polls from the
 * outside for the same reason, which is why its `waitForShellMounted` is shaped
 * this way.) Each fresh evaluate binds to the CURRENT context, so this observes
 * the real page.
 */
async function pollUntil(
  ws: WebSocket,
  expression: string,
  satisfied: (value: string) => boolean,
  deadlineMs: number
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    // A navigation can destroy the context between attempts; that is a reason to
    // try again, not to fail the run.
    const value = await evaluate(ws, expression).catch(() => "");
    if (satisfied(value)) return true;
    await sleep(200);
  }
  return false;
}

/**
 * Open a peek by clicking a page entity ref, the way an operator does.
 *
 * Setting `?peek=` directly would be shorter and would verify the RENDERER while
 * saying nothing about the wiring that gets a user there — the half that broke in
 * mt#2398, where every real click 404'd while the renderer itself was fine
 * (`cockpit-design` §"Verifying a render change").
 */
async function openPeek(ws: WebSocket): Promise<"ok" | "no-entity-ref" | "no-pane"> {
  const ready = await pollUntil(ws, PAGE_REF_COUNT, (v) => Number(v) > 0, 25_000);
  if (!ready) return "no-entity-ref";
  if ((await evaluate(ws, CLICK_PAGE_REF)) === "no-entity-ref") return "no-entity-ref";
  const opened = await pollUntil(ws, PEEK_IS_OPEN, (v) => v === "open", 20_000);
  return opened ? "ok" : "no-pane";
}

/**
 * Read pane geometry once it has stopped changing.
 *
 * A fixed sleep before a geometry read is a guess about how long layout takes on
 * this machine under this load; on a contended run it samples mid-layout and
 * reports a geometry that never existed — a flake indistinguishable from a real
 * failure. Polling until two consecutive samples agree makes the wait a function
 * of the observed page.
 */
async function readWhenStable(ws: WebSocket, what: string): Promise<PaneGeometry> {
  const DEADLINE_MS = 15_000;
  const started = Date.now();
  let previousKey: string | null = null;
  let last: PaneGeometry | null = null;

  while (Date.now() - started < DEADLINE_MS) {
    const state = JSON.parse(await evaluate(ws, READ_PANE)) as PaneGeometry;
    last = state;
    if (state.present) {
      const key = `${state.paneWidth}:${state.bodyGutterPx}:${state.headerGutterPx}:${state.scrollerCount}`;
      if (key === previousKey) return state;
      previousKey = key;
    }
    await sleep(100);
  }
  throw new Error(
    `pane geometry never stabilized within ${DEADLINE_MS}ms while waiting for ${what} ` +
      `(last sample: ${last ? JSON.stringify(last) : "none"})`
  );
}

// --- Run -----------------------------------------------------------------

const failures: string[] = [];
const teardown: Array<() => Promise<unknown>> = [];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

const startUrl = `${COCKPIT}/tasks/${encodeURIComponent(TASK_ID)}`;

let ws: WebSocket;
try {
  const newRes = await fetch(`${CDP}/json/new?${encodeURIComponent(startUrl)}`, { method: "PUT" });
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

/** Measure the pane at one viewport and append to {@link failures}. */
async function checkViewport(
  label: string,
  { width, height }: { width: number; height: number },
  maxPaneFraction: number
): Promise<void> {
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Open the peek only if one is not already up — the SAME pane is measured at
  // both viewports, and the peek survives a resize because its state lives in
  // the URL.
  //
  // Re-opening per viewport was the first shape of this script and it is subtly
  // wrong: an ordinary click REPLACES the last pane, so the second viewport
  // measured whichever entity the second click resolved to. It reported "0
  // scroll containers" for a pane that was laying out correctly and had simply
  // swapped in a short body. Resizing one pane keeps the subject fixed, which is
  // what makes the two readings comparable at all.
  if ((await evaluate(ws, PEEK_IS_OPEN).catch(() => "")) !== "open") {
    const result = await openPeek(ws);
    if (result === "no-entity-ref") {
      failures.push(
        `${label}: ${startUrl} rendered no entity ref to click — wrong task id, or the page failed to load`
      );
      return;
    }
    if (result !== "ok") {
      failures.push(`${label}: clicking an entity ref opened no peek pane within 20s`);
      return;
    }
  }

  let g: PaneGeometry;
  try {
    g = await readWhenStable(ws, `${label} after opening a peek`);
  } catch (err) {
    failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const pct = Math.round((g.paneWidth / g.viewportWidth) * 100);
  console.log(
    `${label} (${width}x${height}): pane=${g.paneWidth}px (${pct}%) page=${g.pageColumnPx}px ` +
      `gutters header=${g.headerGutterPx} body=${g.bodyGutterPx} scrollers=${g.scrollerCount} ` +
      `subject="${g.subject}"`
  );

  // 1. Real gutters — the reported defect, in its own units.
  if (g.bodyGutterPx < MIN_GUTTER_PX) {
    failures.push(
      `${label}: pane content sits ${g.bodyGutterPx}px from the pane edge (need >= ${MIN_GUTTER_PX}px) — text is flush against the frame`
    );
  }

  // 2. Header and body agree, so the left edge is a straight line.
  if (Math.abs(g.headerGutterPx - g.bodyGutterPx) > 1) {
    failures.push(
      `${label}: header gutter (${g.headerGutterPx}px) and body gutter (${g.bodyGutterPx}px) disagree — a step in the pane's left edge`
    );
  }

  // 3/4. One scrollport, and no nested one.
  if (g.scrollerCount !== 1) {
    failures.push(
      `${label}: expected exactly one scroll container in the pane, found ${g.scrollerCount}: ` +
        `${JSON.stringify(g.scrollerClasses)}`
    );
  } else if (!g.scrollerIsPaneBody) {
    // A count of one is not the whole criterion, and saying "found 1" for this
    // case reads as a contradiction. The single scroller can be a body's INNER
    // container while the pane's own body scrolls nothing — which is exactly the
    // unfixed state: the capped spec block scrolled and the pane did not.
    failures.push(
      `${label}: the pane's one scroll container is not the pane's own body — a body is scrolling its own content ` +
        `inside a pane that cannot scroll: ${JSON.stringify(g.scrollerClasses)}`
    );
  }
  if (g.cappedScrollers.length > 0) {
    failures.push(
      `${label}: ${g.cappedScrollers.length} descendant(s) carry the nested-scroller shape (a height cap plus their own overflow): ` +
        `${JSON.stringify(g.cappedScrollers)}`
    );
  }

  // 5/6. The page keeps its place.
  if (g.paneWidth > g.viewportWidth * maxPaneFraction) {
    failures.push(
      `${label}: the pane takes ${pct}% of the viewport (limit ${Math.round(maxPaneFraction * 100)}%) — ` +
        `the page behind is no longer what the operator is mostly looking at`
    );
  }
  if (g.pageColumnPx < MIN_PAGE_COLUMN_PX) {
    failures.push(
      `${label}: the page is left ${g.pageColumnPx}px (need >= ${MIN_PAGE_COLUMN_PX}px) — too narrow to read, which is the state mt#4123 was filed for`
    );
  }
}

try {
  await cdp(ws, "Runtime.enable");
  // Measure the DEFAULT layout, which is what every threshold below encodes.
  //
  // Since mt#4261 the pane width is an operator PREFERENCE in `localStorage`, and
  // this browser profile is shared with `verify-peek-resize.ts` — whose last act
  // is a deliberate full-width drag. Without this clear, that leftover preference
  // is what gets measured here, and the script reports a fraction violation that
  // says nothing about the layout: the pane is wide because someone dragged it,
  // which is the feature working. (Observed exactly that way on this task's own
  // first paired run: 800px/56% at 1440.) An operator's own too-wide preference
  // is bounded by `MIN_PAGE_COLUMN_PX` in `lib/peek-width.ts`, and asserted by
  // the sibling script.
  //
  // The mount poll before the clear is load-bearing for the reason `pollUntil`
  // above documents: `localStorage` is per-ORIGIN, and a tab opened via
  // `PUT /json/new` is typically still on the pre-navigation document when the
  // first evaluate lands — so clearing too early empties `about:blank`'s store
  // and leaves the cockpit's untouched, with nothing to notice.
  await pollUntil(ws, PAGE_REF_COUNT, (v) => Number(v) > 0, 25_000);
  await evaluate(
    ws,
    `(() => { try { localStorage.removeItem("cockpit.peek.width.v1"); } catch (e) {} return "ok"; })()`
  ).catch(() => "");
  await cdp(ws, "Page.reload").catch(() => {});
  await checkViewport("wide (1440, desktop)", WIDE, MAX_PANE_FRACTION_WIDE);
  await checkViewport("narrow (620, the reported width)", NARROW, MAX_PANE_FRACTION_NARROW);
} catch (err) {
  failures.push(`measurement error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await teardownAll();
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} peek-layout assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  "\nPASS: the peek pane has real gutters, one scrollport, and leaves the page readable."
);
