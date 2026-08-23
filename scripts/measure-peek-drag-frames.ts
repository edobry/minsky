#!/usr/bin/env bun
/**
 * Per-FRAME measurement of the cockpit peek's resize drag (mt#4296).
 *
 * ## Why this exists, when mt#4274 already measured the drag
 *
 * mt#4274 cut per-pointermove script cost 11.82ms -> 0.60ms and its harness
 * reported ~4ms per move on the fixed build. The principal, on that same build:
 * *"lil better, still sluggish"*. The disagreement is the finding — a number
 * that looks fine beside a symptom that persists means the number is answering
 * a different question than the one being asked.
 *
 * Three ways mt#4274's harness could look good while the drag feels bad, all
 * three structural rather than a matter of running it more carefully:
 *
 * 1. **It summed.** `Performance.getMetrics` deltas across a whole drag give
 *    totals. A drag with a good mean and a periodic 40ms spike feels sluggish
 *    and measures fine, because the spike is 3% of the sum and 100% of what the
 *    hand notices. Smoothness is a property of the WORST frames, not the mean.
 * 2. **It sampled slowly.** 60 moves over ~2000-3600ms is 17-30 moves/sec. A
 *    trackpad delivers 60-120/sec. Per-frame cost at the real rate can be
 *    several times what was sampled, and the browser's event coalescing behaves
 *    differently when events actually queue up.
 * 3. **It never measured latency.** The reported symptom is the pane lagging
 *    the cursor — pointer-event-to-paint. That is not derivable from CPU time
 *    per move; a frame can be cheap and still land late.
 *
 * So this script measures the three quantities that CAN disagree with a healthy
 * sum, using the APIs Chrome documents for exactly this
 * (https://developer.chrome.com/docs/web-platform/long-animation-frames):
 *
 * - **Frame cadence** — `requestAnimationFrame` timestamps through the drag.
 *   Inter-frame intervals give p50/p95/max and a dropped-frame count. This is
 *   the quantity closest to "does it feel smooth".
 * - **Long Animation Frames (LoAF)** — `PerformanceObserver` on
 *   `long-animation-frame` (Chrome 123+). Reports rendering updates delayed past
 *   50ms, and — unlike a total — attributes the delay across script,
 *   style-and-layout, and render phases. `blockingDuration` is the part that
 *   actually blocks input.
 * - **Event Timing** — `PerformanceObserver` on `event`, which for a
 *   `pointermove` gives `processingStart`/`processingEnd`/`duration`, where
 *   `duration` spans the event's arrival to the next paint. That IS the
 *   pointer-to-paint latency criterion 3 asks for, measured rather than inferred.
 *
 * ## The rate is the other half, and it is why this does not await CDP acks
 *
 * `verify-peek-resize.ts` awaits each `Input.dispatchMouseEvent` round-trip,
 * which caps the achievable rate at whatever the CDP round-trip costs — that is
 * where 17-30/sec comes from, not from a deliberate choice. Sends over one
 * WebSocket are ordered, so pacing sends WITHOUT awaiting each ack delivers a
 * realistic stream while preserving order. The script then reports the rate it
 * ACHIEVED, computed from the elapsed wall clock, not the rate it requested —
 * a requested rate is an intention, and the whole point here is to stop
 * reporting intentions as measurements.
 *
 * Runs the same drag at several rates so the rate-dependence is visible in one
 * run. If the numbers are healthy at 120Hz, that is a finding too, and criterion
 * 4 of the spec says to report it as one rather than optimizing a healthy path.
 *
 * ## Usage
 *
 *   bun scripts/measure-peek-drag-frames.ts
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`), `MINSKY_PEEK_TASK_ID`
 * (default `mt#4123`), `MINSKY_DRAG_RATES` (comma-separated Hz, default
 * `30,60,120`).
 *
 * Exit codes: 0 = measurement completed (READ THE NUMBERS — 0 does not mean
 * "fast"), 2 = could not measure (prerequisite absent or the page never
 * produced frames), 1 = a hard failure.
 *
 * Sibling whose CDP shape and preflight this follows:
 * `scripts/verify-peek-resize.ts`.
 */
import { preflightCockpit } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const TASK_ID = process.env["MINSKY_PEEK_TASK_ID"] ?? "mt#4123";
const RATES = (process.env["MINSKY_DRAG_RATES"] ?? "30,60,120")
  .split(",")
  .map((r) => Number(r.trim()))
  .filter((r) => Number.isFinite(r) && r > 0);

const VIEWPORT = { width: 1440, height: 900 };

/**
 * One frame's budget at 60Hz. Used to classify an inter-frame gap as dropped.
 *
 * 1.5x rather than 1.0x: a frame that lands at 17.0ms instead of 16.7ms has not
 * dropped anything, it has jittered, and counting that as a drop would report a
 * perfect page as broken. At 1.5x (25ms) a gap can only mean at least one
 * refresh interval produced no frame.
 */
const FRAME_BUDGET_MS = 1000 / 60;
const DROPPED_FACTOR = 1.5;

/** How long each rate's drag runs. Long enough to collect a usable sample. */
const DRAG_DURATION_MS = 1500;

/** How far the pointer travels, round trip, during a drag. */
const DRAG_AMPLITUDE_PX = 160;

const EXIT_INCOMPLETE = 2;

await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

// --- CDP plumbing (shape follows verify-peek-resize.ts) -------------------

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

/**
 * Send a CDP command WITHOUT awaiting its ack.
 *
 * This is the whole reason a realistic input rate is reachable — see the header.
 * Ordering is preserved because a WebSocket delivers in order; what is given up
 * is per-message error reporting, which is why every unawaited send here is a
 * `dispatchMouseEvent` (whose failure would show up immediately as a drag that
 * does not move) and never a command whose result is read.
 */
function cdpSend(ws: WebSocket, method: string, params: Record<string, unknown>): void {
  ws.send(JSON.stringify({ id: ++msgId, method, params }));
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
 * Poll an in-page condition from OUTSIDE, one `Runtime.evaluate` per attempt.
 *
 * Not a style preference — an in-page loop stays pinned to the document that
 * existed when it started, which for a freshly-opened tab is the pre-navigation
 * one (mem#1097). `verify-peek-resize.ts` carries the same helper for the same
 * reason.
 */
async function pollUntil(
  ws: WebSocket,
  expression: string,
  predicate: (value: string) => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(ws, expression).catch(() => "");
    if (predicate(value)) return true;
    await sleep(250);
  }
  return false;
}

// Selectors lifted verbatim from `verify-peek-resize.ts` rather than re-derived.
// The load-bearing one is PEEK_IS_OPEN: it requires the pane to carry real TEXT,
// not merely to exist. The first run of this script gated on "a pane element is
// present" and measured a 20-element empty shell — a drag over no content, which
// is the cheap case and precisely not the one under investigation.
const PAGE_REF_COUNT = `(() => {
  const host = document.querySelector('[data-testid="peek-host"]');
  return String(Array.from(document.querySelectorAll("a[data-entity-ref]"))
    .filter((a) => !host || !host.contains(a)).length);
})()`;

const CLICK_PAGE_REF = `(() => {
  const host = document.querySelector('[data-testid="peek-host"]');
  const ref = Array.from(document.querySelectorAll("a[data-entity-ref]"))
    .find((a) => !host || !host.contains(a));
  if (!ref) return "no-entity-ref";
  ref.click();
  return "clicked";
})()`;

const PEEK_IS_OPEN = `(() => {
  const pane = document.querySelector('[data-testid="peek-pane"]');
  return pane && pane.innerText.length > 200 ? "open" : "closed";
})()`;

// --- In-page probe -------------------------------------------------------

/**
 * Install the per-frame recorder.
 *
 * Everything here has to run IN the page: frame cadence and the two
 * PerformanceObserver streams are only observable from inside the document that
 * is actually rendering. The outside half of this script drives input and reads
 * the collected result back out.
 *
 * `buffered: true` is deliberately NOT used — each run starts its own recording
 * so a previous rate's entries cannot leak into the next rate's numbers.
 */
const INSTALL_PROBE = `(() => {
  if (window.__peekProbe) window.__peekProbe.stop();
  const frames = [];
  const loaf = [];
  const events = [];
  let running = true;
  let rafHandle = 0;

  const onFrame = (t) => {
    if (!running) return;
    frames.push(t);
    rafHandle = requestAnimationFrame(onFrame);
  };
  rafHandle = requestAnimationFrame(onFrame);

  let loafObs = null;
  try {
    loafObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        loaf.push({
          duration: e.duration,
          blockingDuration: e.blockingDuration,
          renderDelay: e.renderStart ? e.renderStart - e.startTime : null,
          styleAndLayout: e.styleAndLayoutStart && e.renderStart
            ? (e.startTime + e.duration) - e.styleAndLayoutStart
            : null,
        });
      }
    });
    loafObs.observe({ type: "long-animation-frame" });
  } catch (err) { loafObs = null; }

  let eventObs = null;
  let eventsSeenTotal = 0;
  const eventNames = {};
  try {
    eventObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // Count and name EVERY entry before filtering. The first run of this
        // script filtered on "pointermove" alone and reported NaN latency —
        // indistinguishable, from the output, from "the drag was never slow".
        // CDP's Input.dispatchMouseEvent type "mouseMoved" produces a mousemove,
        // and the pointermove is synthesised from it, so which name carries the
        // entry is a browser detail this must not silently depend on.
        eventsSeenTotal++;
        eventNames[e.name] = (eventNames[e.name] || 0) + 1;
        if (e.name !== "pointermove" && e.name !== "mousemove") continue;
        events.push({
          name: e.name,
          duration: e.duration,
          processing: e.processingEnd - e.processingStart,
          delay: e.processingStart - e.startTime,
        });
      }
    });
    // durationThreshold 16 is the lowest the spec permits; the default of 104
    // would hide exactly the mid-range latencies this is looking for.
    eventObs.observe({ type: "event", durationThreshold: 16 });
  } catch (err) { eventObs = null; }

  // --- Pointer-to-paint, measured directly ---------------------------------
  //
  // Event Timing CANNOT supply this for a drag. Its entry list covers DISCRETE
  // events; a continuous pointermove/mousemove produces no 'event' entry at all.
  // Measured, not assumed: an earlier run of this script logged 118 event-timing
  // entries across a real drag — pointerover/enter/out/leave/down/up/click — and
  // zero moves. Reporting "no entries" as low latency would have been a probe
  // that cannot fail.
  //
  // So measure it the only way that stays true to the quantity: stamp each
  // pointermove as the page receives it, then close it out on the next rendered
  // frame. move -> next paint IS the lag the operator sees between cursor and pane.
  // Take the LAST move before the paint, not the first.
  //
  // The distinction is the whole measurement at high input rates, and getting it
  // wrong manufactures precisely the effect this script was built to look for.
  // With input at 120Hz and the page painting at ~30fps, about four moves land
  // per frame. Stamping the FIRST one measures from an input the browser already
  // superseded — an age that grows with the input rate purely because more moves
  // fit in a frame. That is not lag the operator can perceive: the pane paints
  // the position of the most recent move, so the felt lag is that move's age.
  //
  // Both are recorded so the gap between them stays visible rather than being a
  // claim in a comment: moveLatencies (last, the real quantity) and
  // staleMoveLatencies (first, kept only to show what the wrong choice costs).
  const moveLatencies = [];
  const staleMoveLatencies = [];
  let newestPending = null;
  let oldestPending = null;
  let movesObserved = 0;
  const onMove = (ev) => {
    movesObserved++;
    newestPending = ev.timeStamp;
    if (oldestPending === null) oldestPending = ev.timeStamp;
  };
  document.addEventListener("pointermove", onMove, { capture: true, passive: true });
  const latencyTick = () => {
    if (!running) return;
    if (newestPending !== null) {
      const now = performance.now();
      moveLatencies.push(now - newestPending);
      if (oldestPending !== null) staleMoveLatencies.push(now - oldestPending);
      newestPending = null;
      oldestPending = null;
    }
    requestAnimationFrame(latencyTick);
  };
  requestAnimationFrame(latencyTick);

  window.__peekProbe = {
    stop() {
      document.removeEventListener("pointermove", onMove, { capture: true });
      running = false;
      cancelAnimationFrame(rafHandle);
      if (loafObs) loafObs.disconnect();
      if (eventObs) eventObs.disconnect();
    },
    read() {
      // Take the pending records too: an observer callback is itself scheduled,
      // so entries from the last frames of the drag can still be queued when the
      // outside caller asks. Dropping them would systematically discard the
      // entries most likely to be the slow ones.
      if (loafObs) for (const e of loafObs.takeRecords()) {
        loaf.push({ duration: e.duration, blockingDuration: e.blockingDuration, renderDelay: null, styleAndLayout: null });
      }
      if (eventObs) for (const e of eventObs.takeRecords()) {
        eventsSeenTotal++;
        eventNames[e.name] = (eventNames[e.name] || 0) + 1;
        if (e.name === "pointermove" || e.name === "mousemove") events.push({ name: e.name, duration: e.duration, processing: e.processingEnd - e.processingStart, delay: e.processingStart - e.startTime });
      }
      return JSON.stringify({
        frames,
        loaf,
        events,
        moveLatencies,
        staleMoveLatencies,
        movesObserved,
        eventsSeenTotal,
        eventNames,
        loafSupported: loafObs !== null,
        eventSupported: eventObs !== null,
      });
    },
  };
  return "installed";
})()`;

type ProbeResult = {
  frames: number[];
  loaf: { duration: number; blockingDuration: number }[];
  events: { name: string; duration: number; processing: number; delay: number }[];
  moveLatencies: number[];
  staleMoveLatencies: number[];
  movesObserved: number;
  eventsSeenTotal: number;
  eventNames: Record<string, number>;
  loafSupported: boolean;
  eventSupported: boolean;
};

// --- Stats ---------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

type RateReport = {
  requestedHz: number;
  /** Rate of CDP messages SENT — an upper bound on what the page could receive. */
  sentHz: number;
  /** Rate of pointermove events the PAGE actually received. The real input rate. */
  observedHz: number;
  /** Refresh interval derived from the fastest frames observed, not assumed. */
  nativeIntervalMs: number;
  /** Latency computed from the FIRST move in a frame — kept only as a contrast. */
  staleLatencyP95: number;
  movesObserved: number;
  movesSent: number;
  elapsedMs: number;
  frameCount: number;
  intervalP50: number;
  intervalP95: number;
  intervalMax: number;
  droppedFrames: number;
  droppedPct: number;
  loafCount: number;
  loafMaxDuration: number;
  loafMaxBlocking: number;
  pointerMoveCount: number;
  pointerLatencyP95: number;
  pointerLatencyMax: number;
};

function summarize(
  requestedHz: number,
  movesSent: number,
  elapsedMs: number,
  probe: ProbeResult
): RateReport {
  const intervals: number[] = [];
  for (let i = 1; i < probe.frames.length; i++) {
    intervals.push((probe.frames[i] as number) - (probe.frames[i - 1] as number));
  }
  const sortedIntervals = [...intervals].sort((a, b) => a - b);

  // Derive the display's refresh interval instead of assuming 60Hz.
  //
  // A hardcoded 16.67ms budget misreports on any other panel, and the machine
  // this was written on is 120Hz: an idle 8.3ms cadence is four frames per
  // 33.3ms, not "two dropped frames" against a 60Hz yardstick. The 5th
  // percentile is the fastest cadence the display actually delivered in this
  // sample — a floor the hardware demonstrated rather than one assumed.
  const nativeIntervalMs = sortedIntervals.length
    ? percentile(sortedIntervals, 5)
    : FRAME_BUDGET_MS;
  const dropped = intervals.filter((d) => d > nativeIntervalMs * DROPPED_FACTOR).length;

  const staleLatencies = [...probe.staleMoveLatencies].sort((a, b) => a - b);

  // From the in-page move->next-paint recorder, NOT from Event Timing — see the
  // long note in the probe for why Event Timing cannot answer this for a drag.
  const latencies = [...probe.moveLatencies].sort((a, b) => a - b);
  const moves = probe.moveLatencies;

  return {
    requestedHz,
    // Sent vs observed are different quantities and the gap is the interesting
    // part: sends are what this script emitted, observed is what the page's own
    // listener counted. Reporting sends as "achieved" would credit the harness
    // for input the browser coalesced away.
    sentHz: round((movesSent / elapsedMs) * 1000),
    observedHz: round((probe.movesObserved / elapsedMs) * 1000),
    nativeIntervalMs: round(nativeIntervalMs),
    staleLatencyP95: round(percentile(staleLatencies, 95)),
    movesObserved: probe.movesObserved,
    movesSent,
    elapsedMs: round(elapsedMs),
    frameCount: probe.frames.length,
    intervalP50: round(percentile(sortedIntervals, 50)),
    intervalP95: round(percentile(sortedIntervals, 95)),
    intervalMax: round(sortedIntervals.length ? (sortedIntervals.at(-1) as number) : NaN),
    droppedFrames: dropped,
    droppedPct: intervals.length ? round((dropped / intervals.length) * 100) : 0,
    loafCount: probe.loaf.length,
    loafMaxDuration: round(probe.loaf.length ? Math.max(...probe.loaf.map((l) => l.duration)) : 0),
    loafMaxBlocking: round(
      probe.loaf.length ? Math.max(...probe.loaf.map((l) => l.blockingDuration)) : 0
    ),
    pointerMoveCount: moves.length,
    pointerLatencyP95: round(percentile(latencies, 95)),
    pointerLatencyMax: round(latencies.length ? (latencies.at(-1) as number) : NaN),
  };
}

// --- Page driving --------------------------------------------------------

const READ_GEOMETRY = `(() => {
  const divider = document.querySelector('[data-testid="peek-divider"]');
  const pane = document.querySelector('[data-testid="peek-pane"]');
  const d = divider ? divider.getBoundingClientRect() : null;
  return JSON.stringify({
    dividerPresent: Boolean(divider),
    paneCount: document.querySelectorAll('[data-testid="peek-pane"]').length,
    x: d ? Math.round(d.left + d.width / 2) : 0,
    y: d ? Math.round(d.top + d.height / 2) : 0,
    paneWidth: pane ? Math.round(pane.getBoundingClientRect().width) : 0,
    paneElements: pane ? pane.querySelectorAll("*").length : 0,
  });
})()`;

/**
 * Drag back and forth at a paced rate for a fixed wall-clock duration.
 *
 * Back-and-forth rather than one sweep: a one-directional drag at 120Hz for
 * 1.5s would run into the clamp and spend most of the sample measuring a pane
 * that is no longer changing width, which is the cheap case and not the one
 * under investigation.
 */
async function dragAtRate(
  ws: WebSocket,
  originX: number,
  y: number,
  hz: number
): Promise<{ movesSent: number; elapsedMs: number }> {
  const common = { button: "left", buttons: 1, clickCount: 1 };
  const intervalMs = 1000 / hz;

  await cdp(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x: originX, y, ...common });

  const started = performance.now();
  let movesSent = 0;
  let nextAt = started;

  while (performance.now() - started < DRAG_DURATION_MS) {
    const now = performance.now();
    if (now < nextAt) {
      // Busy-yield in small slices. `sleep(0)` alone would spin the event loop
      // far faster than the target rate; a full `sleep(intervalMs)` would
      // accumulate timer drift and undershoot the rate it claims to deliver.
      await sleep(Math.min(4, Math.max(0, nextAt - now)));
      continue;
    }
    // A triangle wave across the amplitude, so the pane is always in motion.
    const phase = ((now - started) / 400) % 2;
    const offset = (phase < 1 ? phase : 2 - phase) * DRAG_AMPLITUDE_PX;
    cdpSend(ws, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(originX - offset),
      y,
      ...common,
    });
    movesSent++;
    nextAt += intervalMs;
  }

  const elapsedMs = performance.now() - started;

  // One awaited round-trip flushes everything queued above: the ack cannot come
  // back before the browser has processed the messages ahead of it in order.
  await cdp(ws, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: originX,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });

  return { movesSent, elapsedMs };
}

// --- Run -----------------------------------------------------------------

async function openTab(): Promise<{ ws: WebSocket; targetId: string }> {
  const url = `${COCKPIT}/tasks/${encodeURIComponent(TASK_ID)}`;
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
  });
  return { ws, targetId: target.id };
}

async function closeTab(targetId: string): Promise<void> {
  try {
    await fetch(`${CDP}/json/close/${targetId}`);
  } catch {
    // Best-effort teardown; a leaked tab is not worth failing a measurement over.
  }
}

let targetId = "";
try {
  const opened = await openTab();
  const ws = opened.ws;
  targetId = opened.targetId;

  await cdp(ws, "Runtime.enable");
  // Tell the page it is focused (mt#4349).
  //
  // A tab opened via `PUT /json/new` is not the foreground tab, and Chrome
  // throttles a backgrounded page. Measured on verify-peek-resize.ts: ~40%
  // of runs failed with the shell painted and the data query never resolving,
  // and enabling this took that to 0/20. A throttled tab also renders at a
  // reduced rAF cadence, which is exactly the quantity this script measures —
  // so without this, the idle-cadence figure describes the throttle, not the page.
  await cdp(ws, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {
    // Older protocol builds may not carry it; the run is still valid, just
    // subject to the throttling this works around.
  });

  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // No explicit `Page.navigate` here. `PUT /json/new?<url>` already navigates,
  // and issuing a second navigation to the same URL restarts the load — the app
  // then never reached a mounted state within the poll window on the first run
  // of this script. `pollUntil` below is what handles the mem#1097 hazard (the
  // tab still being on about:blank at the first evaluate): it polls the live
  // document rather than assuming one navigation has landed.
  if (!(await pollUntil(ws, PAGE_REF_COUNT, (v) => Number(v) > 0, 25_000))) {
    console.error(
      `SKIP: ${COCKPIT}/tasks/${TASK_ID} never mounted an entity ref to click — ` +
        `nothing to open a peek from. This is an unperformed check, not a passing one.`
    );
    await closeTab(targetId);
    process.exit(EXIT_INCOMPLETE);
  }

  // Start from no stored width preference.
  //
  // This must happen AFTER the poll above, not before: `localStorage` is
  // per-ORIGIN and a `PUT /json/new` tab is still on about:blank at the first
  // evaluate (mem#1097), so clearing early empties the wrong store and leaves
  // the cockpit's intact.
  //
  // Why it matters here specifically: a leftover preference can pin the pane at
  // its clamp ceiling (800px at this viewport), where a widening drag has
  // nowhere to go and legitimately moves 0px. The first run of this script after
  // the navigation fix did exactly that — `verify-peek-resize.ts` had just left
  // an 800px preference behind — and the width control below caught it. Clearing
  // makes the drag's headroom a property of the default, not of whatever ran last.
  await evaluate(
    ws,
    `(() => { try { localStorage.removeItem("cockpit.peek.width.v1"); } catch (e) {} return "ok"; })()`
  );
  await cdp(ws, "Page.reload").catch(() => {});
  if (!(await pollUntil(ws, PAGE_REF_COUNT, (v) => Number(v) > 0, 25_000))) {
    console.error("SKIP: the app did not re-mount after clearing the width preference.");
    await closeTab(targetId);
    process.exit(EXIT_INCOMPLETE);
  }

  if ((await evaluate(ws, PEEK_IS_OPEN)) !== "open") {
    if ((await evaluate(ws, CLICK_PAGE_REF)) === "no-entity-ref") {
      console.error("SKIP: no clickable entity ref outside the peek host.");
      await closeTab(targetId);
      process.exit(EXIT_INCOMPLETE);
    }
  }

  // Gate on CONTENT, not on the pane element existing — see PEEK_IS_OPEN above.
  if (!(await pollUntil(ws, PEEK_IS_OPEN, (v) => v === "open", 20_000))) {
    console.error(
      `SKIP: a peek pane never filled with content within 20s. Measuring an empty ` +
        `pane would report the cheap case as though it were the reported one.`
    );
    await closeTab(targetId);
    process.exit(EXIT_INCOMPLETE);
  }

  const geometry = JSON.parse(await evaluate(ws, READ_GEOMETRY)) as {
    dividerPresent: boolean;
    x: number;
    y: number;
    paneWidth: number;
    paneElements: number;
  };

  if (!geometry.dividerPresent) {
    console.error(
      "SKIP: the peek opened but carries no resize divider — this build predates mt#4261."
    );
    await closeTab(targetId);
    process.exit(EXIT_INCOMPLETE);
  }

  console.log(
    `Measuring peek drag on ${COCKPIT} at ${VIEWPORT.width}x${VIEWPORT.height}\n` +
      `Pane width ${geometry.paneWidth}px, ${geometry.paneElements} descendant elements in the pane.\n`
  );

  // IDLE BASELINE — the control that makes the drag rows interpretable.
  //
  // A locked ~33.3ms cadence is 30fps, and 30fps has two very different causes:
  // the renderer is THROTTLED (a background/occluded tab gets its rAF clamped,
  // and then every row below reads slow regardless of the drag), or the drag's
  // per-frame work exceeds the display's budget and the compositor falls to a
  // fraction of vsync. Those call for opposite conclusions, and the drag rows
  // alone cannot tell them apart.
  //
  // Same probe, same page, same duration, no input. If idle is fast and dragging
  // is slow, the cost belongs to the drag.
  await evaluate(ws, INSTALL_PROBE);
  await sleep(DRAG_DURATION_MS);
  const idleProbe = JSON.parse(await evaluate(ws, `window.__peekProbe.read()`)) as ProbeResult;
  await evaluate(ws, `window.__peekProbe.stop()`);
  const idle = summarize(0, 0, DRAG_DURATION_MS, idleProbe);
  console.log(
    `  idle (no input): ${idle.frameCount} frames, interval p50 ${idle.intervalP50}ms / ` +
      `p95 ${idle.intervalP95}ms, ${idle.droppedFrames} dropped`
  );

  const reports: RateReport[] = [];
  for (const hz of RATES) {
    // Re-read the divider before EVERY rate. The previous rate's drag left the
    // pane wider, which moves the divider — pressing at the coordinate captured
    // before the first drag lands on empty space, and the drag silently does
    // nothing. That is what the 60Hz row did on the previous run: 0px moved,
    // caught by the width control below rather than reported as a fast drag.
    const here = JSON.parse(await evaluate(ws, READ_GEOMETRY)) as {
      x: number;
      y: number;
      paneWidth: number;
    };

    await evaluate(ws, INSTALL_PROBE);

    // Sample the pane width DURING the drag, not just at its ends. The drag is a
    // triangle wave that returns to its origin, so a before/after comparison of a
    // completed drag legitimately reads ~0 delta — the control has to observe the
    // pane while it is moving.
    await evaluate(
      ws,
      `(() => {
        window.__peekWidths = [];
        const pane = document.querySelector('[data-testid="peek-pane"]');
        window.__peekWidthTimer = setInterval(() => {
          if (pane) window.__peekWidths.push(Math.round(pane.getBoundingClientRect().width));
        }, 50);
        return "ok";
      })()`
    );

    const { movesSent, elapsedMs } = await dragAtRate(ws, here.x, here.y, hz);
    // Let the last frames and their observer callbacks land before reading.
    await sleep(250);
    const probe = JSON.parse(await evaluate(ws, `window.__peekProbe.read()`)) as ProbeResult;
    await evaluate(ws, `window.__peekProbe.stop()`);

    const widths = JSON.parse(
      await evaluate(
        ws,
        `(() => { clearInterval(window.__peekWidthTimer); return JSON.stringify(window.__peekWidths || []); })()`
      )
    ) as number[];
    const widthSpread = widths.length ? Math.max(...widths) - Math.min(...widths) : 0;

    // THE CONTROL. Without it this script can print a flawless cadence for a
    // drag that never moved anything — which is what its own first run did, and
    // is the exact defect class mt#4296 exists to stop repeating: a probe whose
    // output looks the same whether or not the system under test responded.
    if (widthSpread < 20) {
      console.error(
        `SKIP: the pane width moved only ${widthSpread}px across the ${hz}Hz drag ` +
          `(samples: ${widths.length}). The drag did not resize anything, so the frame ` +
          `numbers below would describe an idle page. Not reporting them as a measurement.`
      );
      await closeTab(targetId);
      process.exit(EXIT_INCOMPLETE);
    }
    console.log(
      `  ${hz}Hz: pane swept ${Math.min(...widths)}-${Math.max(...widths)}px ` +
        `(${widthSpread}px), ${probe.eventsSeenTotal} event-timing entries ` +
        `${JSON.stringify(probe.eventNames)}`
    );

    if (!probe.loafSupported || !probe.eventSupported) {
      console.error(
        `WARNING: this browser did not provide ` +
          `${!probe.loafSupported ? "long-animation-frame " : ""}` +
          `${!probe.eventSupported ? "event-timing " : ""}observers — ` +
          `those columns are absent, not zero.`
      );
    }
    if (probe.frames.length < 2) {
      console.error(
        `SKIP: the page produced ${probe.frames.length} animation frames during the ` +
          `${hz}Hz drag — nothing to compute a cadence from.`
      );
      await closeTab(targetId);
      process.exit(EXIT_INCOMPLETE);
    }

    reports.push(summarize(hz, movesSent, elapsedMs, probe));
  }

  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log(
    "Hz req/sent/OBSERVED   moves s/o   frames  interval p50/p95/max ms  refresh  dropped   LoAF n/max  pointer→paint p95/max  (first-move p95)"
  );
  for (const r of reports) {
    console.log(
      `${pad(r.requestedHz, 4)}/${pad(r.sentHz, 6)}/${pad(r.observedHz, 7)}  ` +
        `${pad(r.movesSent, 5)}/${pad(r.movesObserved, 4)}  ${pad(r.frameCount, 6)}  ` +
        `${pad(r.intervalP50, 7)}/${pad(r.intervalP95, 6)}/${pad(r.intervalMax, 6)}  ` +
        `${pad(r.nativeIntervalMs, 6)}  ` +
        `${pad(r.droppedFrames, 4)} (${pad(r.droppedPct, 5)}%)  ` +
        `${pad(r.loafCount, 4)}/${pad(r.loafMaxDuration, 6)}  ` +
        `${pad(r.pointerLatencyP95, 10)}/${pad(r.pointerLatencyMax, 6)}  ` +
        `${pad(r.staleLatencyP95, 8)}`
    );
  }
  console.log(
    `\n"refresh" is the 5th-percentile inter-frame interval — the fastest cadence the\n` +
      `display actually delivered — and a gap over ${DROPPED_FACTOR}x it counts as dropped.\n` +
      `"first-move p95" is the same latency computed from the FIRST move in each frame\n` +
      `instead of the last. It is NOT the operator's lag: it grows with input rate purely\n` +
      `because more moves fit in a frame. Shown so the gap between the two stays visible.`
  );

  const cadenceConfounded = Math.abs(idle.intervalP50 - (reports[0]?.intervalP50 ?? 0)) < 5;
  console.log(`\nExit 0 means the measurement RAN. Read the numbers — it is not a verdict.`);
  if (cadenceConfounded) {
    console.log(
      `\nREAD THE CADENCE COLUMNS WITH THE IDLE ROW, NOT ALONE.\n` +
        `  Idle p50 ${idle.intervalP50}ms vs dragging p50 ${reports[0]?.intervalP50}ms — the page\n` +
        `  renders at this cadence with NO input, so the interval and dropped-frame\n` +
        `  columns are dominated by the page's own continuous re-render (live\n` +
        `  timestamps / SSE), not by the drag. Attributing them to the drag would be\n` +
        `  the same error in the other direction as mt#4274's summed totals.\n` +
        `  The drag-attributable signal here is POINTER->PAINT, which idles at zero\n` +
        `  by construction (no moves). Expect it to FALL as the input rate rises —\n` +
        `  more moves per frame means the last one before a paint is fresher. A\n` +
        `  latency that CLIMBS with rate is the signature of measuring the first\n` +
        `  move in each frame instead of the last, not of a slow drag.`
    );
  }

  const resultsPath = "scripts/peek-drag-frames-results.json";
  await Bun.write(
    `${import.meta.dir}/../${resultsPath}`,
    `${JSON.stringify({ cockpit: COCKPIT, taskId: TASK_ID, viewport: VIEWPORT, geometry, idle, reports }, null, 2)}\n`
  );
  console.log(`Structured results written to ${resultsPath}`);

  await closeTab(targetId);
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  if (targetId) await closeTab(targetId);
  process.exit(1);
}
