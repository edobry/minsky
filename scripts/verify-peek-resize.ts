#!/usr/bin/env bun
/**
 * The peek's resize handle, verified in a real browser (mt#4261).
 *
 * Every criterion mt#4261 was filed against is either GEOMETRIC (the pane got
 * wider, the page column shrank by the same amount, the clamp bound) or depends
 * on a REAL pointer drag reaching a real Radix dismissable layer. Neither is
 * reachable from the component suite: it runs under happy-dom, which has no
 * layout engine — `getBoundingClientRect()` reads 0 there (measured mt#3338) —
 * and its `fireEvent.pointerDown` synthesises an event rather than driving the
 * browser's real input path. `src/cockpit/CLAUDE.md` §"Asserting layout geometry"
 * prescribes exactly this split; this script is the geometry half.
 *
 * A sibling rather than more sections in `verify-peek-pane-layout.ts`: that
 * script is already 495 lines and answers a different question (mt#4123's pane
 * INTERIOR). Run both — this one deliberately does not re-assert its criteria.
 *
 * ## Assertions
 *
 * 1. The handle is present, has a real rendered box, and is keyboard-reachable
 *    with the separator semantics the WAI-ARIA Window Splitter pattern requires
 *    — including `aria-controls` RESOLVING to the pane it sizes, which is the
 *    half a class-list assertion cannot check.
 * 2. A real drag widens the pane, and the page column gives up exactly what the
 *    pane gained. (Both directions: a pane that grows while the page does not
 *    shrink means something else absorbed the change.)
 * 3. The drag does NOT dismiss the peek. This is the regression the whole
 *    `PEEK_ASSEMBLY_ATTR` exemption exists for: the divider is a flex sibling of
 *    the panes, so every pane's Radix layer computes a pointerdown on it as
 *    OUTSIDE. Asserted here rather than only in the component suite because it
 *    is Radix's real deferred outside-listener that has to be observed.
 * 4. The width survives a reload — it is a preference, not pane state.
 * 5. Double-clicking the handle forgets the preference and the pane returns to
 *    its responsive default.
 * 6. The clamp binds: dragging as far as the pointer can go leaves the page a
 *    readable column rather than letting the pane swallow the frame.
 *
 * ## Negative control
 *
 * Recorded rather than re-run here, because the code it needs is deleted: with
 * the `isInsidePeekAssembly` exemption removed from `shouldDismissPeek`,
 * assertion 3 FAILS (the peek closes on the first pointerdown of the drag) and
 * assertions 2, 5 and 6 fail as a consequence — there is no pane left to
 * measure. The same revert against the component suite produced 4 failures /
 * 39 passes; see the mt#4261 PR body for that run.
 *
 * ## Usage
 *
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:5199 bun scripts/verify-peek-resize.ts
 *
 * Prerequisites (each CHECKED at startup — a missing one exits 0 with a `SKIP:`
 * line, so this is safe to run unattended):
 *
 *   1. A cockpit serving THIS tree. A cockpit started from `main` serves
 *      `main`'s build, which is not what you are verifying. Either
 *      `bun run cockpit:build && bun src/cli.ts cockpit start --port=<n>`, or a
 *      vite dev server from the session workspace (`bunx vite --port <n>`).
 *   2. A CDP endpoint (default `127.0.0.1:9222`, the shared dev chromium). This
 *      opens its own tab and closes it on exit.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`), `MINSKY_PEEK_TASK_ID`
 * (default `mt#4123` — any task page carrying at least one entity ref works).
 *
 * Sibling whose CDP shape this follows: `scripts/verify-peek-pane-layout.ts`.
 */
import { preflightCockpit } from "./lib/verify-preflight";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const TASK_ID = process.env["MINSKY_PEEK_TASK_ID"] ?? "mt#4123";

const VIEWPORT = { width: 1440, height: 900 };
/** The window the principal reported mt#4123's crushed-page case from. */
const NARROW_VIEWPORT = { width: 620, height: 900 };

/**
 * How far to drag, in px, for assertion 2.
 *
 * 120px: comfortably above the 16px arrow step so a rounding error cannot
 * account for it, and comfortably below the clamp at this viewport (the ceiling
 * for one pane at 1440 is ~800px against a 416px default), so assertion 2
 * measures the DRAG rather than accidentally measuring the clamp — which is
 * assertion 6's job and wants its own, deliberately excessive, distance.
 */
const DRAG_PX = 120;

/** Tolerance for "the page gave up exactly what the pane gained", in px. */
const CONSERVATION_TOLERANCE_PX = 2;

/** Same threshold `verify-peek-pane-layout.ts` uses, and for the same reason. */
const MIN_PAGE_COLUMN_PX = 300;

await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

// --- CDP plumbing (shape follows verify-peek-pane-layout.ts) -------------

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

/**
 * Poll an in-page condition from OUTSIDE, one `Runtime.evaluate` per attempt.
 *
 * Not a style preference — see the long note on the same function in
 * `verify-peek-pane-layout.ts`: an in-page loop stays pinned to the document
 * that existed when it started, which for a freshly-opened tab is the
 * pre-navigation one.
 */
async function pollUntil(
  ws: WebSocket,
  expression: string,
  satisfied: (value: string) => boolean,
  deadlineMs: number
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const value = await evaluate(ws, expression).catch(() => "");
    if (satisfied(value)) return true;
    await sleep(200);
  }
  return false;
}

// --- In-page expressions -------------------------------------------------

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

/**
 * State to capture when a readiness poll times out (mt#4349).
 *
 * The three precondition failures this script can emit — "never mounted the
 * app", "rendered no entity ref to click", "did not reopen after reload" — all
 * report that a poll expired, and none says WHICH of two very different things
 * happened: the page never became ready, or it was ready and the poll's selector
 * did not see it. Those have opposite fixes, and the messages read identically.
 *
 * Measured before instrumenting: 7/20 runs on a settled daemon fail here, none
 * of them in an assertion. So this is the common path, not an edge case.
 */
const READINESS_DIAGNOSTIC = `(() => {
  const host = document.querySelector('[data-testid="peek-host"]');
  const refs = Array.from(document.querySelectorAll("a[data-entity-ref]"));
  const pane = document.querySelector('[data-testid="peek-pane"]');
  return JSON.stringify({
    readyState: document.readyState,
    href: location.href,
    rootChildren: document.getElementById("root") ? document.getElementById("root").childElementCount : -1,
    bodyTextLen: document.body ? document.body.innerText.length : -1,
    refsTotal: refs.length,
    refsOutsideHost: refs.filter((a) => !host || !host.contains(a)).length,
    peekHostPresent: Boolean(host),
    paneCount: document.querySelectorAll('[data-testid="peek-pane"]').length,
    paneTextLen: pane ? pane.innerText.length : -1,
    // NOTE the doubled backslash: this whole expression is a TEMPLATE LITERAL
    // evaluated in the browser, so a single \\s is consumed by JS before the
    // browser ever sees it, leaving the regex /s+/g — which matches the LETTER
    // s. That shipped briefly and stripped every "s" from the captured text
    // ("Minsky" came back as "Min ky"), which is legible enough to read past
    // and wrong enough to mislead. ESLint's no-useless-escape is what caught it.
    bodySample: document.body ? document.body.innerText.slice(0, 220).replace(/\\s+/g, " ") : "",
  });
})()`;

/**
 * Render the diagnostic beside a timeout, so the failure names its own seam.
 *
 * Never throws: this runs on the failure path, and an error here would replace
 * the real finding with a second one.
 */
async function diagnose(seam: string): Promise<string> {
  const raw = await evaluate(ws, READINESS_DIAGNOSTIC).catch(
    (e: unknown) => `{"diagnosticFailed":${JSON.stringify(String(e))}}`
  );
  return ` [seam=${seam} state=${raw}]`;
}

type ResizeState = {
  panePresent: boolean;
  paneCount: number;
  paneWidth: number;
  pageColumnPx: number;
  viewportWidth: number;
  dividerPresent: boolean;
  dividerWidth: number;
  dividerHeight: number;
  dividerCenterX: number;
  dividerCenterY: number;
  role: string;
  tabIndex: string;
  ariaControls: string;
  ariaControlsResolves: boolean;
  ariaValueNow: string;
  ariaValueMin: string;
  ariaValueMax: string;
  storedWidth: string | null;
  /** Widths of every open pane, so the held-pair case can assert they agree. */
  paneWidths: number[];
  /** True when the document scrolls horizontally — the peek must never cause this. */
  bodyOverflowsX: boolean;
  /** The peek's address, so a resize can be shown not to touch it. */
  search: string;
};

/**
 * Read the handle and the pane together, in one evaluate.
 *
 * One read rather than several: the two are measured against each other in
 * every assertion below, and sampling them in separate round-trips would let a
 * layout settle between them and produce a pairing that never existed.
 */
const READ_STATE = `(() => {
  const pane = document.querySelector('[data-testid="peek-pane"]');
  const divider = document.querySelector('[data-testid="peek-divider"]');
  const paneRect = pane ? pane.getBoundingClientRect() : null;
  const dRect = divider ? divider.getBoundingClientRect() : null;
  const controls = divider ? (divider.getAttribute("aria-controls") || "") : "";
  const ids = controls.split(/\\s+/).filter(Boolean);
  let stored = null;
  try { stored = localStorage.getItem("cockpit.peek.width.v1"); } catch (e) { stored = null; }
  return JSON.stringify({
    panePresent: Boolean(pane),
    paneCount: document.querySelectorAll('[data-testid="peek-pane"]').length,
    paneWidth: paneRect ? Math.round(paneRect.width) : 0,
    pageColumnPx: paneRect ? Math.round(window.innerWidth - paneRect.width) : window.innerWidth,
    viewportWidth: window.innerWidth,
    dividerPresent: Boolean(divider),
    dividerWidth: dRect ? Math.round(dRect.width) : 0,
    dividerHeight: dRect ? Math.round(dRect.height) : 0,
    dividerCenterX: dRect ? Math.round(dRect.left + dRect.width / 2) : 0,
    dividerCenterY: dRect ? Math.round(dRect.top + dRect.height / 2) : 0,
    role: divider ? (divider.getAttribute("role") || "") : "",
    tabIndex: divider ? (divider.getAttribute("tabindex") || "") : "",
    ariaControls: controls,
    ariaControlsResolves: ids.length > 0 && ids.every((id) => document.getElementById(id) !== null),
    ariaValueNow: divider ? (divider.getAttribute("aria-valuenow") || "") : "",
    ariaValueMin: divider ? (divider.getAttribute("aria-valuemin") || "") : "",
    ariaValueMax: divider ? (divider.getAttribute("aria-valuemax") || "") : "",
    storedWidth: stored,
    paneWidths: Array.from(document.querySelectorAll('[data-testid="peek-pane"]'))
      .map((p) => Math.round(p.getBoundingClientRect().width)),
    bodyOverflowsX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    search: location.search,
  });
})()`;

async function readState(ws: WebSocket): Promise<ResizeState> {
  return JSON.parse(await evaluate(ws, READ_STATE)) as ResizeState;
}

/**
 * Read the state once it has stopped changing (mt#4274).
 *
 * Every read here follows an action — a drag, a viewport change, a reset — whose
 * effects land across a React render and a layout pass. A fixed sleep before
 * such a read is a guess about how long that takes on this machine under this
 * load; on a contended run it samples mid-flight and reports a geometry that
 * never existed. This script shipped with fixed sleeps and they bit exactly that
 * way: a post-reset read caught the pane at 421px on its way to 416px, and a
 * post-resize read caught it before the resize listener had re-rendered, both
 * reported as product regressions that a slower read showed were not there.
 * `verify-peek-pane-layout.ts` learned this first; its `readWhenStable` carries
 * the same reasoning.
 *
 * Polling until two consecutive samples agree makes the wait a function of the
 * observed page rather than of the author's guess.
 */
async function readStableState(ws: WebSocket, what: string): Promise<ResizeState> {
  const DEADLINE_MS = 8_000;
  const started = Date.now();
  let previousKey: string | null = null;
  let last: ResizeState | null = null;

  while (Date.now() - started < DEADLINE_MS) {
    const state = await readState(ws);
    last = state;
    const key = `${state.paneWidth}:${state.pageColumnPx}:${state.storedWidth}:${state.paneWidths.join(",")}`;
    if (key === previousKey) return state;
    previousKey = key;
    await sleep(120);
  }
  // FAIL rather than return the last sample. Returning it would hand every
  // downstream assertion a geometry that was still moving when it was read,
  // which is the same class of defect this function exists to remove — and
  // worse, because a never-stabilizing page would then be reported as whatever
  // it happened to look like rather than as a problem. A probe that cannot fail
  // carries no information.
  throw new Error(
    `state never stabilized within ${DEADLINE_MS}ms while waiting for ${what} ` +
      `(last sample: ${last ? JSON.stringify(last) : "none"})`
  );
}

/**
 * Drag the handle with REAL input events.
 *
 * `Input.dispatchMouseEvent` drives the browser's own input pipeline, which
 * produces the pointer events the divider listens for AND the outside-interaction
 * events Radix listens for. A synthesised `element.dispatchEvent` would reach the
 * first and not reliably the second, which would make assertion 3 vacuous — the
 * peek would survive because nothing asked it to close.
 */
async function dragBy(ws: WebSocket, fromX: number, y: number, dx: number): Promise<void> {
  const common = { button: "left", buttons: 1, clickCount: 1 };
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y, ...common });
  // Several steps rather than one jump: a real drag is a stream, and a single
  // move would not exercise the absolute-against-origin arithmetic the divider
  // uses (a cumulative implementation passes a one-step drag and drifts on a
  // real one).
  for (const step of [0.25, 0.5, 0.75, 1]) {
    await cdp(ws, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(fromX + dx * step),
      y,
      ...common,
    });
    await sleep(30);
  }
  await cdp(ws, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: Math.round(fromX + dx),
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(200);
}

async function doubleClickAt(ws: WebSocket, x: number, y: number): Promise<void> {
  for (const clickCount of [1, 2]) {
    await cdp(ws, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount,
    });
    await cdp(ws, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount,
    });
  }
  await sleep(200);
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
  console.error(`FAIL: ${getLoggableErrorSummary(err)}`);
  process.exit(1);
}

/** Diagnostic from openPeek's most recent failure, for the caller to report. */
let lastOpenPeekDiagnostic = "";

async function openPeek(): Promise<boolean> {
  lastOpenPeekDiagnostic = "";
  if ((await evaluate(ws, PEEK_IS_OPEN).catch(() => "")) === "open") return true;
  if (!(await pollUntil(ws, PAGE_REF_COUNT, (v) => Number(v) > 0, 25_000))) {
    lastOpenPeekDiagnostic = await diagnose("openPeek:no-refs-within-25s");
    return false;
  }
  if ((await evaluate(ws, CLICK_PAGE_REF)) === "no-entity-ref") {
    lastOpenPeekDiagnostic = await diagnose("openPeek:click-found-no-ref");
    return false;
  }
  const opened = await pollUntil(ws, PEEK_IS_OPEN, (v) => v === "open", 20_000);
  if (!opened) lastOpenPeekDiagnostic = await diagnose("openPeek:pane-never-filled-within-20s");
  return opened;
}

try {
  await cdp(ws, "Runtime.enable");

  // Tell the page it is focused (mt#4349).
  //
  // A tab opened via `PUT /json/new` in the shared browser is not the
  // foreground tab, and Chrome throttles a backgrounded page: timers are
  // clamped and work the app defers past first paint can stall for a long time.
  // The measured failure signature matches that exactly — the shell renders,
  // `readyState` reaches "complete", and the page then sits with zero entity
  // refs and an "Attention …" placeholder that never resolves, while a direct
  // curl of the same endpoint returns full data 30/30 times.
  //
  // `setFocusEmulationEnabled` makes the page believe it has focus without
  // requiring the tab to actually be raised, which would fight the operator for
  // their own browser.
  await cdp(ws, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {
    // Older protocol builds may not carry it; the run is still valid, just
    // subject to the throttling this works around.
  });

  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Start from no stored preference, so assertion 2's "before" is the documented
  // default rather than whatever a previous run left behind — and this script's
  // own last act is a deliberate full-width drag, so "a previous run" is the norm.
  //
  // WAIT FOR THE REAL DOCUMENT FIRST. A tab opened via `PUT /json/new` is
  // typically still on the pre-navigation document when the first
  // `Runtime.evaluate` lands, and `localStorage` is per-ORIGIN: clearing before
  // the app's document exists removes the key from `about:blank`'s store and
  // leaves the cockpit's intact. Nothing errors — the run simply measures the
  // stale preference as though it were the default, which is how this script
  // first reported "the handle is not tracking the pointer" for a handle that
  // was working: the pane was already pinned at its ceiling, so a widening drag
  // had nowhere to go and the delta was legitimately 0. The sibling script's
  // `pollUntil` docblock records the same trap in its polling form.
  if (!(await pollUntil(ws, PAGE_REF_COUNT, (v) => Number(v) > 0, 25_000))) {
    throw new Error(
      `${startUrl} never mounted the app — cannot establish a clean baseline${await diagnose(
        "initial-mount:no-refs-within-25s"
      )}`
    );
  }
  await evaluate(
    ws,
    `(() => { try { localStorage.removeItem("cockpit.peek.width.v1"); } catch (e) {} return "ok"; })()`
  );
  await cdp(ws, "Page.reload").catch(() => {});
  await sleep(500);

  if (!(await openPeek())) {
    failures.push(
      `${startUrl} rendered no entity ref to click, or the peek never opened${lastOpenPeekDiagnostic}`
    );
  } else {
    const before = await readStableState(ws, "the default width");
    console.log(
      `default: pane=${before.paneWidth}px page=${before.pageColumnPx}px ` +
        `divider=${before.dividerWidth}x${before.dividerHeight} role=${before.role} ` +
        `aria-controls="${before.ariaControls}" (resolves=${before.ariaControlsResolves}) ` +
        `range=[${before.ariaValueMin},${before.ariaValueMax}] now=${before.ariaValueNow}`
    );

    // 1. The handle exists, is a real box, and carries splitter semantics.
    if (!before.dividerPresent) {
      failures.push("no resize handle rendered beside the peek");
    } else {
      if (before.dividerWidth < 1 || before.dividerHeight < 100) {
        failures.push(
          `the handle has no real box (${before.dividerWidth}x${before.dividerHeight}) — a resize target the operator cannot see or hit`
        );
      }
      if (before.role !== "separator") {
        failures.push(`handle role is "${before.role}", expected "separator"`);
      }
      if (before.tabIndex !== "0") {
        failures.push(`handle is not keyboard-reachable (tabindex="${before.tabIndex}")`);
      }
      if (!before.ariaControlsResolves) {
        failures.push(
          `aria-controls="${before.ariaControls}" does not resolve to an element — an aria-controls pointing at nothing is worse than none`
        );
      }
      if (Number(before.ariaValueNow) !== before.paneWidth) {
        failures.push(
          `aria-valuenow (${before.ariaValueNow}) disagrees with the rendered pane width (${before.paneWidth}px)`
        );
      }
      if (Number(before.ariaValueMin) > before.paneWidth) {
        failures.push(
          `aria-valuemin (${before.ariaValueMin}) is above the current width (${before.paneWidth}px) — an announced range the pane is already outside`
        );
      }
    }

    if (before.dividerPresent) {
      // 2/3. A real drag widens the pane, and does not dismiss the peek.
      await dragBy(ws, before.dividerCenterX, before.dividerCenterY, -DRAG_PX);
      const dragged = await readStableState(ws, "the drag to settle");
      console.log(
        `after drag -${DRAG_PX}px: panes=${dragged.paneCount} pane=${dragged.paneWidth}px ` +
          `page=${dragged.pageColumnPx}px stored=${dragged.storedWidth}`
      );

      if (dragged.paneCount === 0) {
        failures.push(
          "dragging the handle DISMISSED the peek — the assembly exemption in peek-dismiss.ts is not holding (mt#4261 assertion 3)"
        );
      } else {
        const gained = dragged.paneWidth - before.paneWidth;
        if (Math.abs(gained - DRAG_PX) > CONSERVATION_TOLERANCE_PX) {
          failures.push(
            `dragging ${DRAG_PX}px changed the pane by ${gained}px — the handle is not tracking the pointer`
          );
        }
        const released = before.pageColumnPx - dragged.pageColumnPx;
        if (Math.abs(released - gained) > CONSERVATION_TOLERANCE_PX) {
          failures.push(
            `the pane gained ${gained}px but the page gave up ${released}px — something else absorbed the change`
          );
        }
        if (dragged.storedWidth === null) {
          failures.push("the dragged width was not persisted — it will be lost on reload");
        }
        // The width is a preference, not part of the peek's address: a copied
        // peek link must not carry the copier's window size.
        if (dragged.search !== before.search) {
          failures.push(
            `resizing changed the URL from "${before.search}" to "${dragged.search}" — the width leaked into the peek's address`
          );
        }
        if (dragged.bodyOverflowsX) {
          failures.push("resizing pushed the document into horizontal scroll");
        }
      }

      // 4. It survives a reload — a preference, not pane state.
      const widthBeforeReload = dragged.paneWidth;
      await cdp(ws, "Page.reload");
      await sleep(600);
      if (await openPeek()) {
        const reloaded = await readStableState(ws, "the reload to restore the width");
        console.log(`after reload: pane=${reloaded.paneWidth}px stored=${reloaded.storedWidth}`);
        if (Math.abs(reloaded.paneWidth - widthBeforeReload) > CONSERVATION_TOLERANCE_PX) {
          failures.push(
            `after reload the pane is ${reloaded.paneWidth}px, not the ${widthBeforeReload}px the operator set`
          );
        }

        // 5. Double-click forgets the preference.
        await doubleClickAt(ws, reloaded.dividerCenterX, reloaded.dividerCenterY);
        const reset = await readStableState(ws, "the double-click reset");
        console.log(`after double-click: pane=${reset.paneWidth}px stored=${reset.storedWidth}`);
        if (reset.storedWidth !== null) {
          failures.push(
            `double-click left a stored width of ${reset.storedWidth} — the preference should be FORGOTTEN, not overwritten with today's default`
          );
        }
        if (Math.abs(reset.paneWidth - before.paneWidth) > CONSERVATION_TOLERANCE_PX) {
          failures.push(
            `after reset the pane is ${reset.paneWidth}px, not the ${before.paneWidth}px default it started at`
          );
        }

        // 6. The clamp binds against a drag that asks for the whole frame.
        await dragBy(ws, reset.dividerCenterX, reset.dividerCenterY, -(VIEWPORT.width - 40));
        const maxed = await readStableState(ws, "the full-width drag to clamp");
        console.log(
          `after a full-width drag: pane=${maxed.paneWidth}px page=${maxed.pageColumnPx}px`
        );
        if (maxed.paneCount === 0) {
          failures.push("the full-width drag dismissed the peek");
        } else if (maxed.pageColumnPx < MIN_PAGE_COLUMN_PX) {
          failures.push(
            `dragging as far as possible left the page ${maxed.pageColumnPx}px (need >= ${MIN_PAGE_COLUMN_PX}px) — the clamp is not binding`
          );
        }

        // 7. The SAME too-wide preference, carried to a narrow window.
        //
        // This is the case a fraction-only ceiling gets wrong, and it is where
        // the whole clamp earns its keep: the operator set 800px on a wide
        // monitor, and the peek must yield rather than reproduce the crushed
        // page mt#4123 was filed for. Measured by shrinking the viewport with
        // the preference already stored — the peek survives a resize because its
        // pane state lives in the URL, so this is the same pane throughout.
        await cdp(ws, "Emulation.setDeviceMetricsOverride", {
          width: NARROW_VIEWPORT.width,
          height: NARROW_VIEWPORT.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sleep(400);
        const narrow = await readStableState(ws, "the narrow viewport to re-clamp");
        console.log(
          `at ${NARROW_VIEWPORT.width}px with an 800px preference: pane=${narrow.paneWidth}px ` +
            `page=${narrow.pageColumnPx}px stored=${narrow.storedWidth}`
        );
        if (narrow.paneCount === 0) {
          failures.push("shrinking the window dismissed the peek");
        } else {
          if (narrow.pageColumnPx < MIN_PAGE_COLUMN_PX) {
            failures.push(
              `at ${NARROW_VIEWPORT.width}px the pane leaves the page ${narrow.pageColumnPx}px ` +
                `(need >= ${MIN_PAGE_COLUMN_PX}px) — a wide-monitor preference is crushing a narrow window`
            );
          }
          // The preference itself must be untouched: bounding what RENDERS is
          // not the same as rewriting what the operator chose, and conflating
          // them would silently shrink their width the first time they used a
          // laptop screen.
          if (narrow.storedWidth !== String(maxed.paneWidth)) {
            failures.push(
              `the stored preference changed from ${maxed.paneWidth} to ${narrow.storedWidth} on a window resize — the render bound overwrote the preference`
            );
          }
        }

        // 8. The held pair: one width for the assembly, and the assembly clamped
        // rather than each pane. This is the combination mt#4123 reasoned about
        // at 1440 only, and the reason the ceiling divides by the pane count.
        await cdp(ws, "Emulation.setDeviceMetricsOverride", {
          ...VIEWPORT,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await sleep(300);
        const held = await evaluate(
          ws,
          `(() => {
            const host = document.querySelector('[data-testid="peek-host"]');
            const pane = document.querySelector('[data-testid="peek-pane"]');
            const ref = Array.from((pane || document).querySelectorAll("a[data-entity-ref]"))[0]
              || Array.from(document.querySelectorAll("a[data-entity-ref]")).find((a) => !host || !host.contains(a));
            if (!ref) return "no-ref";
            const pin = document.querySelector('[data-testid="peek-pane"] button[aria-label^="Hold"]');
            if (pin) pin.click();
            ref.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
            return "held";
          })()`
        );
        if (held !== "held") {
          failures.push("could not stage a held pair — no entity ref available to open beside it");
        } else {
          await pollUntil(
            ws,
            `String(document.querySelectorAll('[data-testid="peek-pane"]').length)`,
            (v) => Number(v) >= 2,
            10_000
          );
          await sleep(400);
          const pair = await readStableState(ws, "the held pair to lay out");
          console.log(
            `held pair at ${VIEWPORT.width}px: widths=${JSON.stringify(pair.paneWidths)} ` +
              `page=${VIEWPORT.width - pair.paneWidths.reduce((a, b) => a + b, 0)}px`
          );
          if (pair.paneWidths.length < 2) {
            failures.push("the hold gesture did not produce a second pane");
          } else {
            if (new Set(pair.paneWidths).size !== 1) {
              failures.push(
                `held panes render at different widths (${JSON.stringify(pair.paneWidths)}) — the width is supposed to be shared`
              );
            }
            const total = pair.paneWidths.reduce((a, b) => a + b, 0);
            if (VIEWPORT.width - total < MIN_PAGE_COLUMN_PX) {
              failures.push(
                `two held panes take ${total}px of ${VIEWPORT.width}px, leaving the page ` +
                  `${VIEWPORT.width - total}px (need >= ${MIN_PAGE_COLUMN_PX}px) — the ceiling is per-pane, not per-assembly`
              );
            }
            if (pair.bodyOverflowsX) {
              failures.push("a held pair pushed the document into horizontal scroll");
            }
          }
        }
      } else {
        failures.push(
          `the peek did not reopen after reload, so assertions 4-6 could not run${lastOpenPeekDiagnostic}`
        );
      }
    }
  }
} catch (err) {
  failures.push(`measurement error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await teardownAll();
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} peek-resize assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  "\nPASS: the peek's handle is real, drags, persists, resets, and its clamp leaves the page readable."
);
