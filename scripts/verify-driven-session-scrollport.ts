#!/usr/bin/env bun
/**
 * The driven page owns its scrollport, verified in a real browser (mt#3737).
 *
 * `/driven/:id` declares its thread box `flex-1 overflow-y-auto`, which READS as
 * "this box scrolls" and for a long time was not: the page column had auto
 * height, so `flex-1` resolved to content height, the box never overflowed, and
 * the shell's `<main>` scrolled instead — taking the composer and the status bar
 * off the top with the transcript. Measured 2026-08-04 before the fix: the box
 * reported `scrollHeight === clientHeight === 2017` while `<main>` reported
 * 2212 / 1084, exactly inverted from the required state.
 *
 * That class of defect is invisible to the component suite. happy-dom has no
 * layout engine, so `clientHeight` / `scrollHeight` read 0 there and the only
 * writable assertion is on the Tailwind classes — which is precisely the
 * surrogate that failed here, since the classes ALREADY said `overflow-y-auto`
 * while the geometry did the opposite. Only a real box model can tell the
 * difference (`src/cockpit/CLAUDE.md` §Asserting layout geometry).
 *
 * Assertions:
 *   1. The thread box is a real scroller: `scrollHeight > clientHeight`.
 *   2. `<main>` is NOT scrolling — the overflow was absorbed by the box, not
 *      handed back up the tree. This is the assertion that fails without the fix.
 *   3. The scroll-parent walk from inside the thread lands on the thread box,
 *      which is what `findScrollParent` (`lib/scroll-pinning.ts`) does at
 *      runtime — so the live-tail pinning logic measures the element the
 *      operator actually scrolls.
 *   4. The composer stays within the viewport with the thread scrolled to its
 *      top AND to its bottom.
 *   5. The same four hold at a sub-`md` viewport, where the shell root turns
 *      `flex-col` and the mt#3335 `min-h-0` trap applies to any new flex layer.
 *
 * Overflow is INJECTED rather than sourced from a long transcript, following
 * `verify-cockpit-shell-scroll.ts`: the invariant is a property of the page's
 * flex chain, not of how much a given session happened to say. Injecting makes
 * the check neither pass nor fail on which driven sessions exist today.
 *
 * Usage:
 *   bun scripts/verify-driven-session-scrollport.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3839 bun scripts/verify-driven-session-scrollport.ts
 *
 * Prerequisites (each is CHECKED at startup — a missing one exits 0 with a
 * `SKIP:` line, so this is safe to run unattended):
 *
 *   1. A running cockpit, started WITHOUT `--no-dev-chromium` (that flag
 *      disables exactly the browser this attaches to):
 *
 *        bun run cockpit:build                    # prod bundle; HMR is unreliable here
 *        bun src/cli.ts cockpit start --port=3839
 *
 *      To verify a change that is not yet on `main`, run BOTH from the SESSION
 *      workspace and point `MINSKY_COCKPIT_URL` at that port — a cockpit started
 *      from `main` serves `main`'s build, not yours.
 *
 *   2. A CDP endpoint at `127.0.0.1:9222` — the shared dev chromium
 *      (`src/cockpit/dev-chromium.ts`). Check with
 *      `curl -s localhost:9222/json/version`.
 *
 *   3. At least one driven session in `GET /api/driven-session`, for a route to
 *      point at. Its status does not matter and nothing is sent to it: the page
 *      renders its shell either way, and the shell is what is being measured.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`).
 *
 * Cost: opens one tab, injects a div, measures, closes. No process spawn, no
 * tokens, a few seconds.
 *
 * Exits non-zero only on a real behavioral failure. Siblings:
 * `scripts/verify-cockpit-shell-scroll.ts` (mt#3335/mt#3338), whose CDP shape
 * this follows, and `scripts/verify-conversation-live-tail.ts` (mt#3376/mt#3445).
 */
import {
  assertServiceIdentity,
  describeHealthIdentityResult,
  SERVICE_IDENTITIES,
} from "../packages/domain/src/deployment/health-identity";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";

/** `md` is Tailwind's 768px: 700 is below it (the mt#3335 regime), 1100 above. */
const NARROW = { width: 700, height: 900 };
const WIDE = { width: 1100, height: 900 };

/** Tall enough to overflow either viewport by a wide margin. */
const PROBE_HEIGHT_PX = 3000;
const PROBE_ID = "mt3737-thread-overflow-probe";

/** Sub-pixel slack at fractional device scales. */
const SLACK_PX = 2;

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

// --- Prerequisites -------------------------------------------------------

/**
 * `/api/health`, NOT `/health` — the latter falls through to the SPA's
 * index.html and answers 200 with HTML, which would make a bare reachability
 * check pass and the identity parse below throw.
 */
const HEALTH = `${COCKPIT}/api/health`;

if (!(await reachable(HEALTH))) skip(`no cockpit reachable at ${COCKPIT}`);
if (!(await reachable(`${CDP}/json/version`))) skip(`no CDP endpoint at ${CDP}`);

/**
 * Assert WHICH service answered, not merely that something did (mt#3148).
 * Every Minsky service is built from the same monorepo, so a misconfigured
 * build can put a different application on this port and answer 200
 * identically. A probe that cannot fail carries no information.
 */
let healthBody: unknown;
try {
  healthBody = await (await fetch(HEALTH, { signal: AbortSignal.timeout(5000) })).json();
} catch (err) {
  console.error(`FAIL: ${HEALTH} did not return JSON: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
const identity = assertServiceIdentity(healthBody, SERVICE_IDENTITIES.cockpit);
if (!identity.ok) {
  console.error(`FAIL: ${describeHealthIdentityResult(identity)}`);
  process.exit(1);
}
console.log(describeHealthIdentityResult(identity));

/** Any driven session id will do — the page's SHELL is what is measured. */
let drivenId: string;
try {
  const listed = (await (
    await fetch(`${COCKPIT}/api/driven-session`, { signal: AbortSignal.timeout(5000) })
  ).json()) as { sessions?: Array<{ sessionId?: string }> };
  const first = listed.sessions?.find((s) => typeof s.sessionId === "string")?.sessionId;
  if (!first) skip("no driven sessions exist — nothing to point a /driven/:id route at");
  drivenId = first;
} catch (err) {
  skip(`could not list driven sessions: ${err instanceof Error ? err.message : err}`);
}
const ROUTE = `${COCKPIT}/driven/${encodeURIComponent(drivenId)}`;
console.log(`route: ${ROUTE}`);

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

/**
 * The thread box, located the way the page identifies it rather than by a
 * test id: the `overflow-y-auto` element inside `<main>` that wraps the
 * conversation. If the page grows a second such element this becomes
 * ambiguous — at which point the right move is a `data-testid`, not a cleverer
 * selector.
 */
const THREAD_SELECTOR = `main .overflow-y-auto`;

const INSTALL_PROBE = `(() => {
  const thread = document.querySelector(${JSON.stringify(THREAD_SELECTOR)});
  if (!thread) return "no-thread";
  let probe = document.getElementById(${JSON.stringify(PROBE_ID)});
  if (!probe) {
    probe = document.createElement("div");
    probe.id = ${JSON.stringify(PROBE_ID)};
    thread.appendChild(probe);
  }
  probe.style.height = ${JSON.stringify(`${PROBE_HEIGHT_PX}px`)};
  probe.style.flex = "none";
  return "ok";
})()`;

/**
 * Walk to the nearest scrolling ancestor, mirroring `findScrollParent`
 * (`src/cockpit/web/lib/scroll-pinning.ts`) — including its requirement that
 * the ancestor ALREADY overflow, which is the clause that made it skip the
 * thread box and settle on `<main>` before the fix.
 */
const SCROLL_PARENT_ROLE = `(() => {
  const thread = document.querySelector(${JSON.stringify(THREAD_SELECTOR)});
  if (!thread) return "no-thread";
  const probe = document.getElementById(${JSON.stringify(PROBE_ID)});
  const start = probe ?? thread.firstElementChild ?? thread;
  const SCROLLING = new Set(["auto", "scroll", "overlay"]);
  let node = start.parentElement;
  while (node) {
    const style = getComputedStyle(node);
    if ((SCROLLING.has(style.overflowY) || SCROLLING.has(style.overflow))
        && node.scrollHeight > node.clientHeight) {
      if (node === thread) return "thread";
      if (node.tagName === "MAIN") return "main";
      return "other:" + node.tagName + "." + String(node.className).slice(0, 40);
    }
    node = node.parentElement;
  }
  return "document";
})()`;

type PageState = {
  hasThread: boolean;
  innerHeight: number;
  threadClientHeight: number;
  threadScrollHeight: number;
  mainClientHeight: number;
  mainScrollHeight: number;
  probeHeight: number;
  composerTop: number;
  composerBottom: number;
  hasComposer: boolean;
};

/**
 * The composer is located by its send control rather than by a wrapper class:
 * the assertion is about whether the operator can still REACH the control, and
 * a wrapper can stay in view while the control it contains is clipped.
 */
const READ = `(() => {
  const thread = document.querySelector(${JSON.stringify(THREAD_SELECTOR)});
  const main = document.querySelector("main");
  if (!thread || !main) return JSON.stringify({ hasThread: false });
  const probe = document.getElementById(${JSON.stringify(PROBE_ID)});
  const composer = document.querySelector("textarea, input[type=text]");
  const c = composer ? composer.getBoundingClientRect() : null;
  return JSON.stringify({
    hasThread: true,
    innerHeight: window.innerHeight,
    threadClientHeight: thread.clientHeight,
    threadScrollHeight: thread.scrollHeight,
    mainClientHeight: main.clientHeight,
    mainScrollHeight: main.scrollHeight,
    probeHeight: probe ? Math.round(probe.getBoundingClientRect().height) : 0,
    hasComposer: !!composer,
    composerTop: c ? Math.round(c.top) : 0,
    composerBottom: c ? Math.round(c.bottom) : 0,
  });
})()`;

const scrollThread = (to: "top" | "bottom") => `(() => {
  const thread = document.querySelector(${JSON.stringify(THREAD_SELECTOR)});
  if (!thread) return "no-thread";
  thread.scrollTop = ${to === "top" ? "0" : "thread.scrollHeight"};
  return String(Math.round(thread.scrollTop));
})()`;

async function waitForThreadMounted(ws: WebSocket): Promise<boolean> {
  const DEADLINE_MS = 20_000;
  const started = Date.now();
  while (Date.now() - started < DEADLINE_MS) {
    const present = await evaluate(
      ws,
      `String(!!document.querySelector(${JSON.stringify(THREAD_SELECTOR)}))`
    );
    if (present === "true") return true;
    await sleep(100);
  }
  return false;
}

/**
 * Read geometry once it has stopped changing. A fixed sleep is a guess about
 * how long layout takes on this machine under this load; polling until two
 * consecutive samples agree makes the wait a function of the observed page, and
 * turns "layout never settled" into an explicit error rather than a silent bad
 * measurement.
 */
async function readWhenStable(ws: WebSocket, what: string): Promise<PageState> {
  const DEADLINE_MS = 15_000;
  const started = Date.now();
  let previousKey: string | null = null;
  let last: PageState | null = null;

  while (Date.now() - started < DEADLINE_MS) {
    const state = JSON.parse(await evaluate(ws, READ)) as PageState;
    last = state;
    if (state.hasThread && state.probeHeight >= PROBE_HEIGHT_PX) {
      const key = `${state.threadClientHeight}:${state.threadScrollHeight}:${state.mainClientHeight}:${state.mainScrollHeight}:${state.composerBottom}`;
      if (key === previousKey) return state;
      previousKey = key;
    }
    await sleep(100);
  }
  throw new Error(
    `geometry never stabilized within ${DEADLINE_MS}ms while waiting for ${what} ` +
      `(last sample: ${last ? JSON.stringify(last) : "none"})`
  );
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

async function checkViewport(
  label: string,
  { width, height }: { width: number; height: number }
): Promise<void> {
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (!(await waitForThreadMounted(ws))) {
    failures.push(
      `${label}: the driven page never rendered its thread box within 20s — bad route, or the bundle failed to boot`
    );
    return;
  }

  const installed = await evaluate(ws, INSTALL_PROBE);
  if (installed !== "ok") {
    failures.push(`${label}: could not install the overflow probe (${installed})`);
    return;
  }

  let state: PageState;
  try {
    state = await readWhenStable(ws, `${label} geometry`);
  } catch (err) {
    failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // 1. The thread box absorbs the overflow.
  if (state.threadScrollHeight <= state.threadClientHeight + SLACK_PX) {
    failures.push(
      `${label}: the thread box is not a scroller — scrollHeight ${state.threadScrollHeight} ` +
        `vs clientHeight ${state.threadClientHeight}. Its flex chain is content-sized again (mt#3737).`
    );
  }

  // 2. …and does not hand it back up the tree.
  if (state.mainScrollHeight > state.mainClientHeight + SLACK_PX) {
    failures.push(
      `${label}: <main> is scrolling — scrollHeight ${state.mainScrollHeight} vs clientHeight ` +
        `${state.mainClientHeight}. The page's overflow escaped its own box, which is what takes ` +
        `the composer off the top of the viewport (mt#3737).`
    );
  }

  // 3. The runtime scroll-parent walk agrees with the geometry.
  const role = await evaluate(ws, SCROLL_PARENT_ROLE);
  if (role !== "thread") {
    failures.push(
      `${label}: findScrollParent would resolve to "${role}", not the thread box — the live-tail ` +
        `pinning logic would measure the wrong element (mt#3737).`
    );
  }

  // 4. The composer stays reachable at both ends of the thread's scroll.
  if (!state.hasComposer) {
    failures.push(`${label}: no composer control found on the driven page`);
  } else {
    for (const end of ["top", "bottom"] as const) {
      await evaluate(ws, scrollThread(end));
      const after = JSON.parse(await evaluate(ws, READ)) as PageState;
      const onScreen =
        after.composerTop >= -SLACK_PX && after.composerBottom <= after.innerHeight + SLACK_PX;
      if (!onScreen) {
        failures.push(
          `${label}: with the thread scrolled to its ${end} the composer is off-screen ` +
            `(top ${after.composerTop}, bottom ${after.composerBottom}, viewport ${after.innerHeight}).`
        );
      }
    }
  }

  console.log(
    `${label}: thread ${state.threadScrollHeight}/${state.threadClientHeight}, ` +
      `main ${state.mainScrollHeight}/${state.mainClientHeight}, scrollParent=${role}`
  );
}

await checkViewport("wide", WIDE);
await checkViewport("narrow", NARROW);

await teardownAll();

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("PASS: the driven page owns its scrollport at both viewports");
