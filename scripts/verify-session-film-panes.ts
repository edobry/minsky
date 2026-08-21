#!/usr/bin/env bun
/**
 * Film ribbon/stage split + cockpit scrollbar chrome, in a real browser (mt#3701).
 *
 * The component suite settles what the divider REPORTS and what the host stores.
 * It cannot settle what any of it MEASURES: happy-dom has no layout engine, so
 * `clientWidth` and `getBoundingClientRect()` read 0 there (src/cockpit/CLAUDE.md
 * §Asserting layout geometry). Three claims therefore only exist here:
 *
 *   1. A real pointer drag on the divider actually moves the split — driven via
 *      CDP `Input.dispatchMouseEvent`, i.e. the browser's own input pipeline,
 *      not a JS-synthesized event the component would have received either way.
 *   2. The container-fraction bound holds: narrow the window far enough and the
 *      ribbon gives way, leaving the stage a real width. In happy-dom the
 *      measured container is always 0, which makes that bound inert by design —
 *      it has never been exercised anywhere but here.
 *   3. The scrollbar treatment resolves from tokens, and `.scrollbar-none` still
 *      out-specifies it.
 *
 * Usage:
 *   bun scripts/verify-session-film-panes.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3839 bun scripts/verify-session-film-panes.ts
 *
 * Prerequisites (each is CHECKED at startup — a missing one exits 0 with a
 * `SKIP:` line, so this is safe to run unattended. A prerequisite that is
 * PRESENT but too slow to answer is a DIFFERENT outcome: `INCOMPLETE:` and
 * exit 2, never a silent 0 — mt#4149):
 *
 *   1. A running cockpit, started WITHOUT `--no-dev-chromium`:
 *
 *        bun run cockpit:build                    # prod bundle; HMR is unreliable here
 *        bun src/cli.ts cockpit start --port=3839
 *
 *      To verify a change that is not yet on `main`, run BOTH from the SESSION
 *      workspace and point `MINSKY_COCKPIT_URL` at that port — a cockpit started
 *      from `main` serves `main`'s build, not yours.
 *
 *   2. A CDP endpoint at `127.0.0.1:9222` (the shared dev chromium).
 *   3. At least one filmable conversation, via
 *      `GET /api/cockpit/session-film/sessions`. A fresh database has none;
 *      that is a SKIP, not a failure.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`).
 *
 * Local/operator-run, not a CI job — CI has neither a cockpit daemon nor a dev
 * chromium. Sibling whose CDP shape this follows:
 * `scripts/verify-cockpit-shell-scroll.ts`.
 */
import { preflightCockpit, skip } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";

/** Mirrors SessionFilm.tsx. Duplicated rather than imported: this script drives
 *  the SERVED bundle, whose constants are whatever was built — importing the
 *  source would assert the build against itself. */
const DEFAULT_RIBBON_WIDTH_PX = 256;
const MIN_RIBBON_WIDTH_PX = 192;
const MAX_RIBBON_FRACTION = 0.6;

const WIDE = { width: 1400, height: 900 };
/** Narrow enough that 60% of the split is below the default ribbon width. */
const NARROW = { width: 520, height: 900 };

const DRAG_PX = 120;

// --- Prerequisites -------------------------------------------------------

/**
 * ABSENT, SLOW and WRONG-SERVICE are three different answers (mt#4149), and the
 * shared preflight keeps them apart: a missing cockpit is a `SKIP:` + exit 0, a
 * present-but-over-budget one exits non-zero rather than printing the same line,
 * and `/api/health`'s `service` field is asserted rather than a bare 200.
 */
const { healthBody } = await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

/**
 * Record WHICH build answered, not merely that a cockpit did.
 *
 * The identity check above settles the SERVICE; it cannot settle the WORKTREE,
 * and on a machine running several sessions' cockpits at once the difference is
 * the whole ballgame — a port freed by one session is taken by another within
 * seconds, and the replacement answers `/api/health` identically. Printing the
 * served commit is what lets a reader of this output tell whether the build
 * measured was the one under review. (This happened twice while writing this
 * script: once on 3841, once on 3847, both caught only by this field.)
 */
const servedCommit =
  healthBody && typeof healthBody === "object" && "commit" in healthBody
    ? String((healthBody as { commit?: unknown }).commit)
    : "unknown";
console.log(`served build: commit=${servedCommit} at ${COCKPIT}`);

/**
 * Pick a conversation whose film actually has rows.
 *
 * `agentSessionId` is the id field this endpoint returns, and it IS what the
 * events endpoint's `conversationId` param and the `/conversation/:id/film`
 * route expect — the same id-space, under the name the sessions payload happens
 * to use. Verified against a live cockpit rather than assumed.
 *
 * Candidates are probed rather than taken on faith: `scrubGateOk` says a film is
 * PERMITTED, not that it is non-empty, and a film with no rows would fail the
 * split assertions below for a reason that has nothing to do with this change.
 */
type FilmSession = { agentSessionId?: string; scrubGateOk?: boolean; ingestedAt?: string | null };
const MIN_FILM_EVENTS = 10;
const MAX_CANDIDATES = 6;

let filmConversationId: string | undefined;
try {
  const res = await fetch(`${COCKPIT}/api/cockpit/session-film/sessions`, {
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as { sessions?: FilmSession[] };
  const candidates = (body.sessions ?? [])
    .filter((s) => s.scrubGateOk !== false && typeof s.agentSessionId === "string")
    .sort((a, b) => String(b.ingestedAt ?? "").localeCompare(String(a.ingestedAt ?? "")))
    .slice(0, MAX_CANDIDATES);
  for (const candidate of candidates) {
    const id = candidate.agentSessionId as string;
    const events = await fetch(
      `${COCKPIT}/api/cockpit/session-film/events?conversationId=${encodeURIComponent(id)}`,
      { signal: AbortSignal.timeout(30_000) }
    );
    if (!events.ok) continue;
    const payload = (await events.json()) as { events?: unknown[] };
    if ((payload.events?.length ?? 0) >= MIN_FILM_EVENTS) {
      filmConversationId = id;
      break;
    }
  }
} catch (err) {
  skip(`could not list filmable conversations: ${err instanceof Error ? err.message : err}`);
}
if (!filmConversationId) {
  skip(`no conversation with at least ${MIN_FILM_EVENTS} film events in this database`);
}
console.log(`film subject: ${filmConversationId}`);

const FILM_URL = `${COCKPIT}/conversation/${filmConversationId}/film`;

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

// --- In-page expressions -------------------------------------------------

type SplitState = {
  present: boolean;
  splitWidth: number;
  ribbonWidth: number;
  stageWidth: number;
  dividerWidth: number;
  gripWidth: number;
  gripHeight: number;
  /** Divider midpoint in viewport coordinates — where the drag starts. */
  dividerCenterX: number;
  dividerCenterY: number;
  /** Positive when the stage's left edge sits at or right of the divider's. */
  stageClearsDivider: boolean;
  ariaValueNow: string | null;
  ariaValueMax: string | null;
};

const READ_SPLIT = `(() => {
  const ribbon = document.querySelector('[data-testid="session-film-ribbon"]');
  const divider = document.querySelector('[data-testid="session-film-divider"]');
  const grip = document.querySelector('[data-testid="session-film-divider-grip"]');
  // Guard BEFORE dereferencing: this runs on every poll, including the ones
  // before the film has mounted anything at all.
  if (!ribbon || !divider) return JSON.stringify({ present: false });
  // The stage is the divider's next sibling: its root is PanZoomSVG's <svg>,
  // which carries no test id of its own (the id inside it is on a <g>, whose
  // box is the SCENE's, not the pane's).
  const stage = divider.nextElementSibling;
  if (!stage) return JSON.stringify({ present: false });
  const split = divider.parentElement;
  const r = ribbon.getBoundingClientRect();
  const d = divider.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  const g = grip ? grip.getBoundingClientRect() : { width: 0, height: 0 };
  return JSON.stringify({
    present: true,
    splitWidth: Math.round(split.getBoundingClientRect().width),
    ribbonWidth: Math.round(r.width),
    stageWidth: Math.round(s.width),
    dividerWidth: Math.round(d.width),
    gripWidth: Math.round(g.width),
    gripHeight: Math.round(g.height),
    dividerCenterX: Math.round(d.left + d.width / 2),
    dividerCenterY: Math.round(d.top + d.height / 2),
    stageClearsDivider: s.left >= d.right - 1,
    ariaValueNow: divider.getAttribute("aria-valuenow"),
    ariaValueMax: divider.getAttribute("aria-valuemax"),
  });
})()`;

/**
 * Scrollbar chrome, measured on a real overflowing element.
 *
 * The gutter (`offsetWidth - clientWidth`) is REPORTED rather than asserted to
 * an exact width: whether a styled scrollbar reserves layout space depends on
 * the host's "show scroll bars" setting, and pinning a number here would make
 * the check pass or fail on a macOS preference. What IS asserted does not
 * depend on that setting.
 *
 * THREE probes since mt#4355, because the treatment became opt-IN. Until then
 * this measured `probe("")` — a BARE element — and asserted the token color
 * resolved on it, which is now the opposite of the contract:
 *
 *   - `scrollbar-readout` → the token-built treatment applies.
 *   - bare               → it does NOT. This is the assertion that keeps the
 *                          `*`-selector reach from creeping back; without it
 *                          nothing distinguishes "opt-in" from "global".
 *   - `scrollbar-none`   → still fully suppressed (the TabBar depends on it).
 *
 * The probes stay `position: fixed`, NOT `absolute` (PR #3188 R1). Nesting is
 * what makes inheritance observable, and inheritance is DOM-based — measured:
 * a fixed child of an element carrying
 * `scrollbar-color: rgb(255, 0, 0) rgb(0, 128, 0)` computes that same pair,
 * identically to an absolute or static child. So `fixed` costs nothing, and
 * `absolute` would have cost something real: one of the two containers these
 * probes are parented into is `<main>`, an `overflow: auto` scroller, and an
 * absolutely-positioned child at `top: -9999px` participates in its ancestor's
 * scrollable overflow — the probe would perturb the very box it measures.
 * `fixed` is out of flow entirely, and immune to an ancestor `overflow: hidden`
 * clipping it or a `transform` re-anchoring it.
 *
 * `colorScheme` rides along and is the more important of the two mechanisms:
 * it is what makes the PLATFORM's own bar dark on engines that ignore the
 * token treatment — WebKit, i.e. the tray. Note the limit this script cannot
 * cross: it drives Chromium, so a passing `colorScheme` here is evidence the
 * declaration SHIPPED, not that the tray renders correctly. That check is the
 * principal's window.
 */
const PROBE_ID = "mt3701-scrollbar-probe";
const MEASURE_SCROLLBAR = `(() => {
  function probe(className, parent) {
    const host = document.createElement("div");
    host.className = className;
    // position:fixed, never absolute — see the docblock above (PR #3188 R1).
    host.style.cssText = "position:fixed;top:-9999px;left:0;width:120px;height:80px;overflow-y:scroll";
    const filler = document.createElement("div");
    filler.style.height = "800px";
    host.appendChild(filler);
    host.id = ${JSON.stringify(PROBE_ID)} + "-" + (className || "bare");
    (parent || document.body).appendChild(host);
    const cs = getComputedStyle(host);
    const out = {
      gutter: host.offsetWidth - host.clientWidth,
      scrollbarWidth: cs.scrollbarWidth,
      scrollbarColor: cs.scrollbarColor,
    };
    host.remove();
    return out;
  }
  // The NESTED probes are the load-bearing ones. \`scrollbar-color\` inherits,
  // so a probe parented to <body> sits outside every opted-in container and
  // reports "auto" whether or not the treatment leaks downward — it cannot
  // fail on the regression it is meant to catch. Parent inside the opted-in
  // scroller instead, which is where a real code block or table wrapper lives.
  const readoutHost = document.querySelector(".scrollbar-readout");
  return JSON.stringify({
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    readout: probe("scrollbar-readout"),
    bare: probe(""),
    optedOut: probe("scrollbar-none"),
    foundReadoutHost: Boolean(readoutHost),
    bareNested: readoutHost ? probe("", readoutHost) : null,
    readoutNested: readoutHost ? probe("scrollbar-readout", readoutHost) : null,
  });
})()`;

type ScrollbarProbe = { gutter: number; scrollbarWidth: string; scrollbarColor: string };

/**
 * Start from the shipped default rather than from whatever this profile last
 * did.
 *
 * The ribbon width PERSISTS, and the canary profile is shared and long-lived —
 * so a previous run of this very script leaves its drag behind, and the second
 * run then measures a 376px "default". A check whose expected values depend on
 * its own history is not a check. Clearing the key and reloading makes each run
 * start from the same state; the side effect is that running this resets the
 * operator's ribbon width in the canary profile, which is not the profile they
 * work in.
 */
const RESET_STORED_WIDTH = `(() => {
  try { localStorage.removeItem("cockpit.session-film.ribbon-width.v1"); } catch { /* private mode */ }
  location.reload();
  return "ok";
})()`;

async function waitForFilm(ws: WebSocket): Promise<boolean> {
  const DEADLINE_MS = 30_000;
  const started = Date.now();
  while (Date.now() - started < DEADLINE_MS) {
    try {
      const state = JSON.parse(await evaluate(ws, READ_SPLIT)) as SplitState;
      if (state.present && state.ribbonWidth > 0) return true;
    } catch {
      // The execution context is torn down and rebuilt across the reload above;
      // an evaluate landing in that window throws. Keep polling — a context
      // that never comes back is caught by the deadline.
    }
    await sleep(150);
  }
  return false;
}

/** Read the split once two consecutive samples agree, so a mid-layout sample
 *  cannot be mistaken for a settled one. */
async function readSplitWhenStable(ws: WebSocket, what: string): Promise<SplitState> {
  const DEADLINE_MS = 15_000;
  const started = Date.now();
  let previousKey: string | null = null;
  let last: SplitState | null = null;
  while (Date.now() - started < DEADLINE_MS) {
    const state = JSON.parse(await evaluate(ws, READ_SPLIT)) as SplitState;
    last = state;
    if (state.present) {
      const key = `${state.splitWidth}:${state.ribbonWidth}:${state.stageWidth}`;
      if (key === previousKey) return state;
      previousKey = key;
    }
    await sleep(100);
  }
  throw new Error(
    `the split never stabilized within ${DEADLINE_MS}ms while waiting for ${what} ` +
      `(last sample: ${last ? JSON.stringify(last) : "none"})`
  );
}

/** Drag the divider `dx` px with the browser's own input pipeline. */
async function dragDivider(ws: WebSocket, from: SplitState, dx: number): Promise<void> {
  const y = from.dividerCenterY;
  const x = from.dividerCenterX;
  await cdp(ws, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  // A few intermediate moves rather than one jump: closer to a real drag, and
  // it exercises the continuous-report path rather than a single delta.
  for (const step of [0.25, 0.5, 0.75, 1]) {
    await cdp(ws, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(x + dx * step),
      y,
      button: "left",
      buttons: 1,
    });
    await sleep(20);
  }
  await cdp(ws, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: Math.round(x + dx),
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

// --- Run -----------------------------------------------------------------

const failures: string[] = [];
const teardown: Array<() => Promise<unknown>> = [];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

let ws: WebSocket;
try {
  const newRes = await fetch(`${CDP}/json/new?${encodeURIComponent(FILM_URL)}`, { method: "PUT" });
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
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    ...WIDE,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // Wait for a first mount, then reset the persisted width and let it come back
  // at the default — see RESET_STORED_WIDTH.
  await waitForFilm(ws);
  await evaluate(ws, RESET_STORED_WIDTH).catch(() => "");

  if (!(await waitForFilm(ws))) {
    failures.push(
      `the film never rendered a ribbon + divider at ${FILM_URL} within 30s — ` +
        `a bad route, a scrub-gated conversation, or a bundle that predates mt#3701`
    );
  } else {
    // --- 1. Opens at the default, with a grip that is actually drawn --------
    const initial = await readSplitWhenStable(ws, "the film's first paint");
    console.log(
      `wide (${WIDE.width}x${WIDE.height}): split=${initial.splitWidth} ribbon=${initial.ribbonWidth} ` +
        `stage=${initial.stageWidth} divider=${initial.dividerWidth} grip=${initial.gripWidth}x${initial.gripHeight}`
    );
    if (initial.ribbonWidth !== DEFAULT_RIBBON_WIDTH_PX) {
      failures.push(
        `the ribbon opened at ${initial.ribbonWidth}px, expected the ${DEFAULT_RIBBON_WIDTH_PX}px default ` +
          `(a stored preference in this profile's localStorage would also explain it)`
      );
    }
    if (!(initial.gripWidth > 0 && initial.gripHeight > 0)) {
      failures.push(
        `the divider's grip has no rendered box (${initial.gripWidth}x${initial.gripHeight}) — ` +
          `the handle is invisible, which is the affordance mt#3701 exists to provide`
      );
    }
    if (!initial.stageClearsDivider) {
      failures.push(`the stage overlaps the divider at rest`);
    }

    // --- 2. A real pointer drag moves the split ---------------------------
    await dragDivider(ws, initial, DRAG_PX);
    const dragged = await readSplitWhenStable(ws, "the drag to settle");
    console.log(
      `after +${DRAG_PX}px drag: ribbon=${dragged.ribbonWidth} stage=${dragged.stageWidth} ` +
        `aria-valuenow=${dragged.ariaValueNow}`
    );
    const expected = DEFAULT_RIBBON_WIDTH_PX + DRAG_PX;
    if (Math.abs(dragged.ribbonWidth - expected) > 2) {
      failures.push(
        `a +${DRAG_PX}px drag left the ribbon at ${dragged.ribbonWidth}px, expected ~${expected}px`
      );
    }
    if (dragged.stageWidth >= initial.stageWidth) {
      failures.push(
        `the stage did not give up the width the ribbon took ` +
          `(${initial.stageWidth} -> ${dragged.stageWidth})`
      );
    }
    if (!dragged.stageClearsDivider) {
      failures.push(`the stage overlaps the divider after the drag`);
    }
    if (dragged.ariaValueNow !== String(dragged.ribbonWidth)) {
      failures.push(
        `aria-valuenow (${dragged.ariaValueNow}) disagrees with the rendered width ` +
          `(${dragged.ribbonWidth}) — a screen reader would report the wrong size`
      );
    }

    // --- 3. The container-fraction bound (only observable here) ------------
    await cdp(ws, "Emulation.setDeviceMetricsOverride", {
      ...NARROW,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const narrow = await readSplitWhenStable(ws, "the narrow viewport");
    const ceiling = Math.round(narrow.splitWidth * MAX_RIBBON_FRACTION);
    console.log(
      `narrow (${NARROW.width}x${NARROW.height}): split=${narrow.splitWidth} ribbon=${narrow.ribbonWidth} ` +
        `stage=${narrow.stageWidth} fraction-ceiling=${ceiling} aria-valuemax=${narrow.ariaValueMax}`
    );
    // The announced range must be the REACHABLE one (PR #2632 R1). This is the
    // only place it can be checked: happy-dom measures the container as 0, where
    // the fraction bound — and therefore the whole discrepancy — does not exist.
    const announcedMax = Number(narrow.ariaValueMax);
    const reachableMax = Math.max(ceiling, MIN_RIBBON_WIDTH_PX);
    if (!Number.isFinite(announcedMax) || Math.abs(announcedMax - reachableMax) > 2) {
      failures.push(
        `at ${NARROW.width}px the divider announces aria-valuemax=${narrow.ariaValueMax} while only ` +
          `${reachableMax}px is reachable — assistive tech would report a range that does not exist`
      );
    }
    // `min` outranks the fraction by design, so the bound is "at the ceiling OR
    // at the floor" — a ribbon pinned to MIN in a window too narrow for both is
    // the documented outcome, not a failure.
    if (narrow.ribbonWidth > Math.max(ceiling, MIN_RIBBON_WIDTH_PX) + 2) {
      failures.push(
        `at ${NARROW.width}px the ribbon holds ${narrow.ribbonWidth}px, past both the ` +
          `${MAX_RIBBON_FRACTION} fraction ceiling (${ceiling}) and the ${MIN_RIBBON_WIDTH_PX}px floor`
      );
    }
    if (narrow.stageWidth <= 0) {
      failures.push(`at ${NARROW.width}px the stage has no width left`);
    }
  }

  // --- 4. Scrollbar chrome ------------------------------------------------
  const scrollbars = JSON.parse(await evaluate(ws, MEASURE_SCROLLBAR)) as {
    colorScheme: string;
    readout: ScrollbarProbe;
    bare: ScrollbarProbe;
    optedOut: ScrollbarProbe;
    foundReadoutHost: boolean;
    bareNested: ScrollbarProbe | null;
    readoutNested: ScrollbarProbe | null;
  };
  console.log(`document color-scheme: ${scrollbars.colorScheme}`);
  console.log(
    `scrollbar (.scrollbar-readout): gutter=${scrollbars.readout.gutter}px width=${scrollbars.readout.scrollbarWidth} ` +
      `color=${scrollbars.readout.scrollbarColor}`
  );
  console.log(
    `scrollbar (bare): gutter=${scrollbars.bare.gutter}px width=${scrollbars.bare.scrollbarWidth} ` +
      `color=${scrollbars.bare.scrollbarColor}`
  );
  console.log(
    `scrollbar (.scrollbar-none): gutter=${scrollbars.optedOut.gutter}px ` +
      `width=${scrollbars.optedOut.scrollbarWidth}`
  );
  if (scrollbars.colorScheme !== "dark") {
    failures.push(
      `the document computes color-scheme "${scrollbars.colorScheme}", expected "dark" — ` +
        `without it the platform paints its own chrome light-appearance, which is what the ` +
        `tray's WebKit window rendered before mt#4355`
    );
  }
  if (scrollbars.readout.scrollbarColor === "auto" || scrollbars.readout.scrollbarColor === "") {
    failures.push(
      `.scrollbar-readout computes scrollbar-color "${scrollbars.readout.scrollbarColor}" — ` +
        `the token-derived declaration did not apply, so the scrollbar is still OS chrome`
    );
  }
  if (scrollbars.readout.scrollbarWidth !== "thin") {
    failures.push(
      `.scrollbar-readout computes scrollbar-width "${scrollbars.readout.scrollbarWidth}", expected "thin"`
    );
  }
  if (scrollbars.bare.scrollbarColor !== "auto" || scrollbars.bare.scrollbarWidth !== "auto") {
    failures.push(
      `a BARE scroll container computes scrollbar-color "${scrollbars.bare.scrollbarColor}" / ` +
        `scrollbar-width "${scrollbars.bare.scrollbarWidth}", expected "auto" for both — the ` +
        `treatment is opt-in per mt#4355 and has leaked back to a global selector`
    );
  }
  if (scrollbars.optedOut.scrollbarWidth !== "none" || scrollbars.optedOut.gutter !== 0) {
    failures.push(
      `.scrollbar-none no longer suppresses scrollbar chrome ` +
        `(width="${scrollbars.optedOut.scrollbarWidth}", gutter=${scrollbars.optedOut.gutter}px) — ` +
        `something out-specifies the opt-out the TabBar depends on`
    );
  }
  // The inheritance pair. Both probes live INSIDE an opted-in scroller, which
  // is the only place the `scrollbar-color` leak is observable.
  if (!scrollbars.foundReadoutHost) {
    failures.push(
      `no .scrollbar-readout element in the document — the nested-inheritance ` +
        `assertions could not run, so this check proved nothing about them`
    );
  } else {
    const nestedBare = scrollbars.bareNested as ScrollbarProbe;
    const nestedReadout = scrollbars.readoutNested as ScrollbarProbe;
    console.log(
      `scrollbar (bare, nested in .scrollbar-readout): width=${nestedBare.scrollbarWidth} ` +
        `color=${nestedBare.scrollbarColor}`
    );
    console.log(
      `scrollbar (.scrollbar-readout, nested): width=${nestedReadout.scrollbarWidth} ` +
        `color=${nestedReadout.scrollbarColor}`
    );
    if (nestedBare.scrollbarColor !== "auto") {
      failures.push(
        `a bare scroll container NESTED inside .scrollbar-readout computes ` +
          `scrollbar-color "${nestedBare.scrollbarColor}", expected "auto" — ` +
          `\`scrollbar-color\` is an INHERITED property, so the treatment is leaking ` +
          `into every nested scroller (code blocks, table wrappers) and the ` +
          `:where(.scrollbar-readout *) reset is missing or out-specified (mt#4355)`
      );
    }
    if (nestedReadout.scrollbarColor === "auto" || nestedReadout.scrollbarWidth !== "thin") {
      failures.push(
        `a .scrollbar-readout NESTED inside another one computes ` +
          `width="${nestedReadout.scrollbarWidth}" color="${nestedReadout.scrollbarColor}" — ` +
          `the descendant reset is out-specifying an explicit opt-in, which would ` +
          `strip the film ribbon's readout (it renders inside <main>)`
      );
    }
  }
} catch (err) {
  failures.push(`measurement error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await teardownAll();
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  "\nPASS: the film split drags, clamps to the container, and the scrollbar chrome is ours."
);
