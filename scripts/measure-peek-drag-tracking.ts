#!/usr/bin/env bun
/**
 * Repeat-run harness for the peek divider's pointer tracking (mt#4343).
 *
 * ## What this is for
 *
 * `scripts/verify-peek-resize.ts` assertion 2 — drag the handle 120px, expect the
 * pane to gain 120px within 2px — fails INTERMITTENTLY on main. Observed
 * 2026-08-19 on commit 34a5475a3: one run reported `-19px` (the pane moved the
 * WRONG WAY), the next run passed, no code change between them.
 *
 * One failing run and one passing run is not an isolation. This script supplies
 * the two things that were missing:
 *
 * 1. **A rate.** N repetitions of exactly that drag, reporting how many missed
 *    and by how much. 1-of-2 is compatible with anything from a 5% flake to a
 *    50% one, and the remedy differs.
 * 2. **An attribution.** The same drag is run two ways in the same session, and
 *    the difference between them is the experiment:
 *
 *    - `sleep` — the driver `verify-peek-resize.ts` actually uses: four
 *      `Input.dispatchMouseEvent` steps with a FIXED 30ms wait between them.
 *    - `poll` — identical events, but each step waits until the pane's geometry
 *      stops changing before sending the next.
 *
 *    If `sleep` misses and `poll` does not, the defect is in the HARNESS: a
 *    fixed wait racing a slow render, which is a documented failure mode of this
 *    exact script (its own docblock records two prior false regressions of that
 *    shape, both fixed by polling). If BOTH miss at similar rates, the fixed
 *    wait is exonerated and the defect is in the PRODUCT's pointer handling —
 *    the more interesting outcome, and the one that would explain the
 *    principal's "still sluggish" report that mt#4296's timing measurement came
 *    back clean on.
 *
 * The third candidate, the shared browser's page zoom (mt#2603), was probed at
 * plan time and found absent (`visualViewport.scale: 1`); this script re-reads it
 * every run so a later zoom cannot silently masquerade as a tracking defect.
 *
 * ## Usage
 *
 *   bun scripts/measure-peek-drag-tracking.ts
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`), `MINSKY_PEEK_TASK_ID`
 * (default `mt#4123`), `MINSKY_TRACKING_RUNS` (per mode, default 30).
 *
 * Exit codes: 0 = the measurement ran (read the rate — 0 is not "no defect"),
 * 2 = could not measure, 1 = hard failure.
 */
import { preflightCockpit } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const TASK_ID = process.env["MINSKY_PEEK_TASK_ID"] ?? "mt#4123";
const RUNS = Number(process.env["MINSKY_TRACKING_RUNS"] ?? "30");

const VIEWPORT = { width: 1440, height: 900 };

/** Same distance and tolerance assertion 2 uses, so this measures THAT check. */
const DRAG_PX = 120;
const TOLERANCE_PX = 2;

const EXIT_INCOMPLETE = 2;

await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

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

const READ_STATE = `(() => {
  const divider = document.querySelector('[data-testid="peek-divider"]');
  const pane = document.querySelector('[data-testid="peek-pane"]');
  const d = divider ? divider.getBoundingClientRect() : null;
  const p = pane ? pane.getBoundingClientRect() : null;
  return JSON.stringify({
    paneCount: document.querySelectorAll('[data-testid="peek-pane"]').length,
    paneWidth: p ? Math.round(p.width) : 0,
    dividerX: d ? Math.round(d.left + d.width / 2) : 0,
    dividerY: d ? Math.round(d.top + d.height / 2) : 0,
    zoom: window.visualViewport ? window.visualViewport.scale : null,
    innerWidth: window.innerWidth,
  });
})()`;

type State = {
  paneCount: number;
  paneWidth: number;
  dividerX: number;
  dividerY: number;
  zoom: number | null;
  innerWidth: number;
};

async function readState(ws: WebSocket): Promise<State> {
  return JSON.parse(await evaluate(ws, READ_STATE)) as State;
}

/** Read once the geometry has stopped moving — the sibling script's discipline. */
async function readStable(ws: WebSocket): Promise<State> {
  const deadline = Date.now() + 8_000;
  let previous = "";
  while (Date.now() < deadline) {
    const s = await readState(ws);
    const key = `${s.paneWidth}:${s.dividerX}`;
    if (key === previous) return s;
    previous = key;
    await sleep(120);
  }
  throw new Error("geometry never stabilized within 8s");
}

/**
 * The drag under test, in the two variants whose difference is the experiment.
 *
 * `sleep` reproduces `verify-peek-resize.ts`'s driver exactly, fixed 30ms and
 * all. `poll` sends the identical event sequence but waits for the pane to stop
 * moving between steps. Anything else about them must stay identical, or the
 * comparison stops attributing anything.
 */
async function dragBy(
  ws: WebSocket,
  fromX: number,
  y: number,
  dx: number,
  mode: "sleep" | "poll"
): Promise<void> {
  const common = { button: "left", buttons: 1, clickCount: 1 };
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y, ...common });
  for (const step of [0.25, 0.5, 0.75, 1]) {
    await cdp(ws, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(fromX + dx * step),
      y,
      ...common,
    });
    if (mode === "sleep") {
      await sleep(30);
    } else {
      await readStable(ws).catch(() => undefined);
    }
  }
  await cdp(ws, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: Math.round(fromX + dx),
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  if (mode === "sleep") await sleep(200);
}

async function resetToDefault(ws: WebSocket): Promise<void> {
  const s = await readStable(ws);
  for (const clickCount of [1, 2]) {
    await cdp(ws, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: s.dividerX,
      y: s.dividerY,
      button: "left",
      buttons: 1,
      clickCount,
    });
    await cdp(ws, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: s.dividerX,
      y: s.dividerY,
      button: "left",
      buttons: 0,
      clickCount,
    });
  }
  await sleep(250);
}

type Outcome = { run: number; before: number; after: number; gained: number; missed: boolean };

async function measureMode(ws: WebSocket, mode: "sleep" | "poll"): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (let run = 1; run <= RUNS; run++) {
    await resetToDefault(ws);
    const before = await readStable(ws);
    if (before.paneCount === 0) throw new Error(`peek closed before run ${run} of mode ${mode}`);
    if (before.zoom !== null && Math.abs(before.zoom - 1) > 0.01) {
      throw new Error(
        `page zoom is ${before.zoom} (mt#2603) — geometry is distorted, refusing to attribute`
      );
    }

    // Negative dx widens the pane: the divider sits on the pane's LEFT edge, so
    // dragging left gives the pane the space. Same sign assertion 2 uses.
    await dragBy(ws, before.dividerX, before.dividerY, -DRAG_PX, mode);
    const after = await readStable(ws);
    const gained = after.paneWidth - before.paneWidth;
    const missed = Math.abs(gained - DRAG_PX) > TOLERANCE_PX;
    outcomes.push({ run, before: before.paneWidth, after: after.paneWidth, gained, missed });
    if (missed) {
      console.log(
        `  [${mode} ${run}/${RUNS}] MISS: ${before.paneWidth} -> ${after.paneWidth} = ${gained}px (wanted ${DRAG_PX})`
      );
    }
  }
  return outcomes;
}

function report(mode: string, outcomes: Outcome[]): void {
  const misses = outcomes.filter((o) => o.missed);
  const gains = outcomes.map((o) => o.gained).sort((a, b) => a - b);
  console.log(
    `${mode.padEnd(6)}  ${outcomes.length} runs, ${misses.length} missed ` +
      `(${Math.round((misses.length / outcomes.length) * 100)}%), ` +
      `gained min/median/max = ${gains[0]}/${gains[Math.floor(gains.length / 2)]}/${gains.at(-1)}px${
        misses.length ? `, misses at runs ${misses.map((m) => m.run).join(",")}` : ""
      }`
  );
}

let targetId = "";
try {
  const url = `${COCKPIT}/tasks/${encodeURIComponent(TASK_ID)}`;
  const res = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
  targetId = target.id;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
  });

  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  if (!(await pollUntil(ws, PAGE_REF_COUNT, (v) => Number(v) > 0, 25_000))) {
    console.error(`SKIP: ${url} never mounted an entity ref — nothing to open a peek from.`);
    await fetch(`${CDP}/json/close/${targetId}`);
    process.exit(EXIT_INCOMPLETE);
  }
  await evaluate(
    ws,
    `(() => { try { localStorage.removeItem("cockpit.peek.width.v1"); } catch (e) {} return "ok"; })()`
  );
  await cdp(ws, "Page.reload").catch(() => {});
  if (!(await pollUntil(ws, PAGE_REF_COUNT, (v) => Number(v) > 0, 25_000))) {
    console.error("SKIP: the app did not re-mount after clearing the width preference.");
    await fetch(`${CDP}/json/close/${targetId}`);
    process.exit(EXIT_INCOMPLETE);
  }
  if ((await evaluate(ws, PEEK_IS_OPEN)) !== "open") {
    if ((await evaluate(ws, CLICK_PAGE_REF)) === "no-entity-ref") {
      console.error("SKIP: no clickable entity ref outside the peek host.");
      await fetch(`${CDP}/json/close/${targetId}`);
      process.exit(EXIT_INCOMPLETE);
    }
  }
  if (!(await pollUntil(ws, PEEK_IS_OPEN, (v) => v === "open", 20_000))) {
    console.error("SKIP: a peek pane never filled with content.");
    await fetch(`${CDP}/json/close/${targetId}`);
    process.exit(EXIT_INCOMPLETE);
  }

  const start = await readStable(ws);
  console.log(
    `Repeating assertion 2's drag on ${COCKPIT} at ${VIEWPORT.width}x${VIEWPORT.height}\n` +
      `Default pane ${start.paneWidth}px, zoom ${start.zoom}, ${RUNS} runs per mode.\n` +
      `A MISS is |gained - ${DRAG_PX}| > ${TOLERANCE_PX}px — assertion 2's own test.\n`
  );

  const sleepOutcomes = await measureMode(ws, "sleep");
  const pollOutcomes = await measureMode(ws, "poll");

  console.log("");
  report("sleep", sleepOutcomes);
  report("poll", pollOutcomes);

  const sleepMisses = sleepOutcomes.filter((o) => o.missed).length;
  const pollMisses = pollOutcomes.filter((o) => o.missed).length;
  console.log(
    `\nAttribution: ${
      sleepMisses === 0 && pollMisses === 0
        ? `NEITHER mode missed in ${RUNS} runs each. The flake did not reproduce here — that is a\n` +
          `  finding, not a pass: it bounds the rate below ~${Math.round(100 / RUNS)}% under THIS\n` +
          `  script's conditions, and does not clear the product. Re-run, and compare conditions\n` +
          `  against the observed failure before concluding anything.`
        : sleepMisses > 0 && pollMisses === 0
          ? `the fixed-wait driver missed ${sleepMisses}/${RUNS} and the polling driver missed none.\n` +
            `  That points at the HARNESS: assertion 2's fixed 30ms step is racing the render.`
          : `both drivers missed (${sleepMisses}/${RUNS} sleep, ${pollMisses}/${RUNS} poll).\n` +
            `  The fixed wait is exonerated; this points at the PRODUCT's pointer handling.`
    }`
  );

  await fetch(`${CDP}/json/close/${targetId}`);
  process.exit(0);
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  if (targetId) await fetch(`${CDP}/json/close/${targetId}`).catch(() => undefined);
  process.exit(1);
}
