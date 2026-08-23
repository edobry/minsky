#!/usr/bin/env bun
/**
 * Session-film camera invariants, verified in a real browser (mt#3792).
 *
 * The component suite (`PanZoomSVG.test.tsx`, AT1-AT5c) runs under happy-dom,
 * which has no layout engine and no real input pipeline: `getBoundingClientRect`
 * reads 0 unless a test mocks it, and a "drag" is three synthesized React
 * events rather than a pointer moving across a compositor. Those tests pin the
 * viewBox ARITHMETIC, which is where all five defects lived — but they cannot
 * see whether the arithmetic keeps actual pixels on actual screen. This script
 * closes that gap by driving the real page and asking the user's question:
 * after I maul the camera, can I still see the world, and does Reset put it
 * back without flickering?
 *
 * The two invariants, stated as a viewer would state them:
 *
 *   1. **You cannot lose the world by dragging.** A drag far larger than the
 *      board leaves at least one stage node inside the viewport. Pre-fix, pan
 *      was unclamped in every direction — one drag put the viewBox at x=13147
 *      against a board at x:[0,900], and nothing on screen indicated which way
 *      to drag back.
 *
 *   2. **Reset settles without a flash.** A pure-translation pan does not
 *      change the viewBox WIDTH, so after Reset the width should hold steady
 *      while the camera eases back. Pre-fix, Reset snapped to the full-board
 *      fit and ambient drift pulled the view off it within ~400ms, so the width
 *      went content-fit -> board -> content-fit: a large, visible round trip
 *      (measured in the component harness as 378 -> 900 -> 371). Sampling the
 *      width across the settle turns that flicker into a number.
 *
 * Assertion 2 is deliberately width-based rather than position-based. Position
 * legitimately changes during the settle (that is the ease doing its job), so a
 * position assertion cannot distinguish "easing home" from "snapping away";
 * width should be near-constant for this gesture, which makes any large
 * excursion in it unambiguous evidence of a framing the camera did not intend
 * to keep.
 *
 * NOT covered here (owned by the component tests, which can drive the inputs
 * this script cannot): camera-follow resuming after Reset with CHANGED bounds
 * (AT3) — the live film's bounds are whatever the transcript produces, and a
 * script cannot move them; the MIN/MAX_SCALE clamps on auto-fit (AT2/AT2b),
 * which need a degenerate and a sprawling bounds on demand; and the
 * no-growingBounds Reset branch (AT5b/AT5c), which this page never exercises.
 *
 * Usage:
 *   bun scripts/verify-session-film-camera.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3839 bun scripts/verify-session-film-camera.ts
 *
 * Prerequisites (each is CHECKED at startup — a missing one exits 0 with a
 * `SKIP:` line, so this is safe to run unattended. A prerequisite that is
 * PRESENT but too slow to answer is a DIFFERENT outcome: `INCOMPLETE:` and
 * exit 2, never a silent 0 — mt#4149):
 *
 *   1. A running cockpit, started WITHOUT `--no-dev-chromium` (that flag
 *      disables exactly the browser this attaches to):
 *
 *        bun run cockpit:build                    # prod bundle; HMR is unreliable here
 *        bun src/cli.ts cockpit start --port=3839
 *
 *      To verify a change that is not yet on `main`, run BOTH from the SESSION
 *      workspace and point `MINSKY_COCKPIT_URL` at that port — a cockpit
 *      started from `main` serves `main`'s build, not yours.
 *
 *   2. A CDP endpoint at `127.0.0.1:9222`. Check with
 *      `curl -s localhost:9222/json/version`.
 *
 *   3. At least one ingested conversation with film events. Discovered from
 *      `/api/cockpit/session-film/sessions`; skips when the corpus is empty.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`),
 * `MINSKY_FILM_CONVERSATION_ID` (pin a specific conversation).
 *
 * Local/operator-run, not a CI job — CI has neither a cockpit daemon nor a dev
 * chromium. Sibling scripts whose CDP shape this follows:
 * `scripts/verify-cockpit-shell-scroll.ts` (mt#3338),
 * `scripts/verify-conversation-live-tail.ts` (mt#3376/mt#3445).
 */
import { preflightCockpit, skip } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const PINNED_CONVERSATION = process.env["MINSKY_FILM_CONVERSATION_ID"];

const VIEWPORT = { width: 1440, height: 900 };

/**
 * Drag distance, in CSS px. An order of magnitude past the viewport so the
 * gesture is unambiguously "off the world" rather than a large-but-legitimate
 * pan — the pre-fix code accepted it and translated the viewBox by the full
 * amount.
 */
const HUGE_DRAG_PX = 12_000;

/** Post-Reset sampling: often enough to catch a ~200ms drift tick, long enough to cover the 900ms ease. */
const SETTLE_SAMPLE_MS = 50;
const SETTLE_WINDOW_MS = 1_600;

/**
 * Largest width excursion tolerated during the post-Reset settle, as a
 * fraction of the settled width. A pure-translation pan should hold width
 * essentially constant; the pre-fix board-fit flash was a ~60% excursion in the
 * component harness (378 -> 900). 0.25 sits well clear of both.
 */
const MAX_WIDTH_EXCURSION = 0.25;

// --- Prerequisites -------------------------------------------------------

/**
 * ABSENT, SLOW and WRONG-SERVICE are three different answers (mt#4149), and the
 * shared preflight keeps them apart: a missing cockpit is a `SKIP:` + exit 0, a
 * present-but-over-budget one exits non-zero rather than printing the same line,
 * and `/api/health`'s `service` field is asserted rather than a bare 200.
 */
await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

/**
 * Pick a conversation to film. Prefer one with a real `startedAt` — the
 * placeholder `agent-*` rows carry no timeline, so their stage can legitimately
 * be empty, which would make assertion 1 vacuous rather than false.
 */
let conversationId: string;
if (PINNED_CONVERSATION) {
  conversationId = PINNED_CONVERSATION;
} else {
  let sessions: Array<{ agentSessionId: string; startedAt: string | null }> = [];
  try {
    const res = await fetch(`${COCKPIT}/api/cockpit/session-film/sessions`, {
      signal: AbortSignal.timeout(10_000),
    });
    sessions = ((await res.json()) as { sessions?: typeof sessions }).sessions ?? [];
  } catch (err) {
    skip(`could not list film sessions: ${err instanceof Error ? err.message : err}`);
  }
  const usable = sessions.find((s) => s.startedAt !== null) ?? sessions[0];
  if (!usable) skip("no ingested conversations with film events");
  conversationId = usable.agentSessionId;
}
const filmUrl = `${COCKPIT}/conversation/${encodeURIComponent(conversationId)}/film`;
console.log(`Filming conversation ${conversationId}`);

// --- CDP plumbing (shape follows verify-cockpit-shell-scroll.ts) ----------

type CdpResult = {
  result?: { value?: string };
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
    // Latch + clear on every exit path so a late timer cannot reject an
    // already-settled promise.
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

const READ_VIEWBOX = `(() => {
  const svg = document.querySelector('[data-testid="pan-zoom-svg"]');
  if (!svg) return "";
  return svg.getAttribute("viewBox") || "";
})()`;

/**
 * How many stage nodes are currently inside the viewport?
 *
 * This is the user-facing form of "the camera is bounded": not a claim about
 * the viewBox numbers, but about whether anything is on screen to look at.
 * Counted against the node groups the stage renders (`session-film-node-*`),
 * intersected with the window rect.
 */
const VISIBLE_NODE_COUNT = `(() => {
  const nodes = document.querySelectorAll('[data-testid^="session-film-node-"]');
  let visible = 0;
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    if (r.right >= 0 && r.left <= window.innerWidth && r.bottom >= 0 && r.top <= window.innerHeight) {
      visible++;
    }
  }
  return JSON.stringify({ total: nodes.length, visible });
})()`;

/** Center of the stage SVG in viewport coordinates — where the synthetic drag starts. */
const STAGE_CENTER = `(() => {
  const svg = document.querySelector('[data-testid="pan-zoom-svg"]');
  if (!svg) return "";
  const r = svg.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
})()`;

const RESET_BUTTON_CENTER = `(() => {
  // data-testid, not the aria-label (PR #2692 review, non-blocking): the label
  // is user-facing copy that a wording change would silently break, and this
  // script would then report "could not locate the Reset button" as though the
  // page were broken.
  const btn = document.querySelector('[data-testid="pan-zoom-reset"]');
  if (!btn) return "";
  const r = btn.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
})()`;

function parseViewBox(vb: string): { x: number; y: number; w: number; h: number } | null {
  const [x, y, w, h] = vb.split(/\s+/).map(Number);
  if (![x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { x: x as number, y: y as number, w: w as number, h: h as number };
}

/**
 * Wait for the stage to actually have nodes.
 *
 * Waiting on the ELEMENT rather than on a duration is what makes this
 * deterministic; a fixed delay long enough on a warm machine is a flake, and
 * one too short reports "the film never rendered" for a page that was merely
 * still loading its events.
 */
async function waitForStage(ws: WebSocket): Promise<boolean> {
  const DEADLINE_MS = 30_000;
  const started = Date.now();
  while (Date.now() - started < DEADLINE_MS) {
    const raw = await evaluate(ws, VISIBLE_NODE_COUNT);
    try {
      const { total } = JSON.parse(raw) as { total: number };
      if (total > 0) return true;
    } catch {
      // stage not mounted yet — VISIBLE_NODE_COUNT returned "" or partial
    }
    await sleep(250);
  }
  return false;
}

/** One synthetic pointer drag, dispatched through the real input pipeline. */
async function dragBy(
  ws: WebSocket,
  from: { x: number; y: number },
  dx: number,
  dy: number
): Promise<void> {
  const common = { button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" };
  await cdp(ws, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...common,
    x: from.x,
    y: from.y,
  });
  // A few intermediate moves rather than one jump: a single giant move is a
  // gesture no real pointer produces, and the handler's clamp must hold across
  // the whole path, not merely at its endpoint.
  const STEPS = 6;
  for (let i = 1; i <= STEPS; i++) {
    await cdp(ws, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...common,
      x: Math.round(from.x + (dx * i) / STEPS),
      y: Math.round(from.y + (dy * i) / STEPS),
    });
  }
  await cdp(ws, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...common,
    x: Math.round(from.x + dx),
    y: Math.round(from.y + dy),
  });
}

async function clickAt(ws: WebSocket, at: { x: number; y: number }): Promise<void> {
  const common = { button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" };
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mousePressed", ...common, x: at.x, y: at.y });
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", ...common, x: at.x, y: at.y });
}

// --- Run -----------------------------------------------------------------

const failures: string[] = [];
const teardown: Array<() => Promise<unknown>> = [];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

let ws: WebSocket;
try {
  // PUT, not GET — this is REQUIRED, not a stylistic choice, and it is the
  // verb both sibling verify scripts use. Chrome added a verb check to the
  // DevTools HTTP endpoint (crbug 1233826, shipped in Chrome 111) so that a
  // hostile page cannot open tabs via a cross-origin <img>/GET; /json/new now
  // answers a GET with `405 Using unsafe HTTP verb GET to invoke /json/new.
  // This action supports only PUT verb.` Verified against the live canary
  // (Chrome 151) while responding to PR #2692's review, which read the PUT as
  // the bug.
  const newRes = await fetch(`${CDP}/json/new?${encodeURIComponent(filmUrl)}`, { method: "PUT" });
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
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  if (!(await waitForStage(ws))) {
    failures.push(
      "the film stage never rendered any nodes within 30s — bad route, empty film, or a bundle that failed to boot"
    );
    throw new Error("stage never rendered");
  }

  // Let camera-follow reach its resting fit before touching anything.
  await sleep(2_000);

  const centerRaw = await evaluate(ws, STAGE_CENTER);
  if (!centerRaw) throw new Error("could not locate the stage SVG");
  const stageCenter = JSON.parse(centerRaw) as { x: number; y: number };

  const beforeRaw = await evaluate(ws, READ_VIEWBOX);
  const before = parseViewBox(beforeRaw);
  if (!before) throw new Error(`unparseable viewBox before the drag: "${beforeRaw}"`);
  console.log(`viewBox at rest: ${beforeRaw}`);

  // --- Invariant 1: you cannot lose the world by dragging ----------------
  await dragBy(ws, stageCenter, -HUGE_DRAG_PX, -HUGE_DRAG_PX);
  await sleep(400);

  const draggedRaw = await evaluate(ws, READ_VIEWBOX);
  const dragged = parseViewBox(draggedRaw);
  console.log(`viewBox after a ${HUGE_DRAG_PX}px drag: ${draggedRaw}`);

  const afterDragCounts = JSON.parse(await evaluate(ws, VISIBLE_NODE_COUNT)) as {
    total: number;
    visible: number;
  };
  console.log(
    `stage nodes on screen after the drag: ${afterDragCounts.visible}/${afterDragCounts.total}`
  );
  if (afterDragCounts.visible === 0) {
    failures.push(
      `a ${HUGE_DRAG_PX}px drag left 0 of ${afterDragCounts.total} stage nodes on screen — the camera is unbounded`
    );
  }
  if (dragged && before && dragged.x === before.x && dragged.y === before.y) {
    failures.push(
      "the drag did not move the camera at all — this run proves nothing about the clamp (check the input pipeline, not the fix)"
    );
  }

  // --- Invariant 2: Reset settles without a flash ------------------------
  const resetRaw = await evaluate(ws, RESET_BUTTON_CENTER);
  if (!resetRaw) throw new Error("could not locate the Reset button");
  await clickAt(ws, JSON.parse(resetRaw) as { x: number; y: number });

  const widths: number[] = [];
  const settleStart = Date.now();
  while (Date.now() - settleStart < SETTLE_WINDOW_MS) {
    const vb = parseViewBox(await evaluate(ws, READ_VIEWBOX));
    if (vb) widths.push(vb.w);
    await sleep(SETTLE_SAMPLE_MS);
  }
  if (widths.length < 5) {
    failures.push(
      `only ${widths.length} viewBox samples across the settle window — too few to judge`
    );
  } else {
    const settled = widths[widths.length - 1] ?? 0;
    const maxExcursion = Math.max(...widths.map((w) => Math.abs(w - settled) / settled));
    console.log(
      `post-Reset width: settled ${settled.toFixed(1)}, ` +
        `range [${Math.min(...widths).toFixed(1)}, ${Math.max(...widths).toFixed(1)}] ` +
        `across ${widths.length} samples, max excursion ${(maxExcursion * 100).toFixed(1)}%`
    );
    if (maxExcursion > MAX_WIDTH_EXCURSION) {
      failures.push(
        `viewBox width swung ${(maxExcursion * 100).toFixed(1)}% of its settled value during the ` +
          `post-Reset settle (tolerance ${(MAX_WIDTH_EXCURSION * 100).toFixed(0)}%) — the camera ` +
          `adopted a framing it then abandoned, which is the visible flicker`
      );
    }
  }

  const afterResetCounts = JSON.parse(await evaluate(ws, VISIBLE_NODE_COUNT)) as {
    total: number;
    visible: number;
  };
  console.log(
    `stage nodes on screen after Reset: ${afterResetCounts.visible}/${afterResetCounts.total}`
  );
  if (afterResetCounts.visible === 0) {
    failures.push("Reset left 0 stage nodes on screen — it did not restore a usable framing");
  }
} catch (err) {
  failures.push(`measurement error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await teardownAll();
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} session-film camera assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  "\nPASS: the camera stays on the world through a huge drag, and Reset settles without a flash."
);
