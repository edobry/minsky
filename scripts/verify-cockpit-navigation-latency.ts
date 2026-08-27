#!/usr/bin/env bun
/**
 * Cockpit page-load / navigation latency baseline, measured in a real browser (mt#3696).
 *
 * The operator's complaint is that moving between entity pages is slow enough
 * to change behavior — leaving a page to look at a referenced entity feels
 * expensive. That is a claim about wall-clock time, and until this script
 * existed there was no way to check it except by feel, and no way to tell a
 * regression from a bad afternoon.
 *
 * What it measures, and why each phase is separate rather than one number:
 *
 *   - **Cold load** — a full document navigation. Attributed to document TTFB,
 *     script fetch (the bundle), DOM-content-loaded, load, and the `/api/*`
 *     requests the page fires. A slow cold load caused by a 700 KB bundle and
 *     one caused by a 1.5 s API read want opposite fixes, so a single
 *     "page took 2 s" number cannot direct any work.
 *   - **Warm in-SPA navigation** — clicking a link inside the already-loaded
 *     SPA. This is the gesture the complaint is actually about; it pays no
 *     bundle cost, so its time is almost entirely API wait plus render.
 *   - **Server phases** — read from `PerformanceResourceTiming.serverTiming`,
 *     which carries whatever `Server-Timing` the route emitted
 *     (`src/cockpit/server-timing.ts`). This is what separates "the server was
 *     slow" from "the network was slow", a split the browser cannot make on
 *     its own. Routes that emit no `Server-Timing` simply report total request
 *     wait with no breakdown — reported honestly as absent, never inferred.
 *
 * Every route is measured `MINSKY_LATENCY_RUNS` times (default 3) and reported
 * as min/median/max. A single sample is not a baseline: measured 2026-08-04,
 * the same detail route ran 0.84 s five times in a row and 8.8 s twice, so a
 * one-shot number would have supported either "fine" or "catastrophic"
 * depending on when it ran.
 *
 * Usage:
 *   bun scripts/verify-cockpit-navigation-latency.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3839 bun scripts/verify-cockpit-navigation-latency.ts
 *   MINSKY_LATENCY_RUNS=5 bun scripts/verify-cockpit-navigation-latency.ts
 *
 * Prerequisites (each is CHECKED at startup — a missing one exits 0 with a
 * `SKIP:` line, so this is safe to run unattended. A prerequisite that is
 * PRESENT but too slow to answer is a DIFFERENT outcome: `INCOMPLETE:` and
 * exit 2, never a silent 0 — mt#4149):
 *
 *   1. A running cockpit, started WITHOUT `--no-dev-chromium` (that flag
 *      disables exactly the browser this attaches to):
 *
 *        bun run cockpit:build                    # prod bundle; HMR distorts timings
 *        bun src/cli.ts cockpit start --port=3839
 *
 *      Measure the PROD bundle. Under `--dev`, Vite serves unbundled modules
 *      through its dev middleware, so the script-fetch numbers describe the dev
 *      server rather than anything an operator ever loads.
 *
 *      To measure a change that is not yet on `main`, run BOTH from the SESSION
 *      workspace and point `MINSKY_COCKPIT_URL` at that port — a cockpit
 *      started from `main` serves `main`'s build, not yours.
 *
 *   2. A CDP endpoint at `127.0.0.1:9222` — the shared dev chromium the cockpit
 *      launches (`src/cockpit/dev-chromium.ts`). Check with
 *      `curl -s localhost:9222/json/version`.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`),
 * `MINSKY_LATENCY_RUNS` (default 3),
 * `MINSKY_LATENCY_OUT` (default `scripts/cockpit-navigation-latency-results.json`).
 *
 * **Exit code reports the SCRIPT's health, not the cockpit's speed.** Slow
 * numbers exit 0 — they are the finding, not a failure. Non-zero means the
 * measurement itself could not be taken (no `<main>` ever rendered, CDP died,
 * a route 404'd). A latency script that failed CI on a slow run would be
 * turned off within a week, and the baseline would go with it.
 *
 * Sibling scripts whose CDP shape this follows:
 * `scripts/verify-cockpit-shell-scroll.ts` (mt#3338),
 * `scripts/verify-conversation-live-tail.ts` (mt#3376/mt#3445).
 */
import { writeFileSync } from "node:fs";
import { preflightCockpit } from "./lib/verify-preflight";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const RUNS = Math.max(1, Number(process.env["MINSKY_LATENCY_RUNS"] ?? 3) || 3);
const OUT = process.env["MINSKY_LATENCY_OUT"] ?? "scripts/cockpit-navigation-latency-results.json";

const VIEWPORT = { width: 1440, height: 900 };
/** How long a page gets to stop changing before a sample is abandoned. */
const SETTLE_DEADLINE_MS = 25_000;
const SETTLE_INTERVAL_MS = 100;
/** Consecutive quiet samples required before the page counts as settled. */
const SETTLE_QUIET_SAMPLES = 3;
/**
 * Floor on how early a page may be declared settled. Between React mounting and
 * its first data effect firing there is a window where nothing is in flight and
 * the skeleton already has text — indistinguishable, sample by sample, from a
 * finished page.
 */
const MIN_OBSERVE_MS = 700;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Prerequisites -------------------------------------------------------

/**
 * ABSENT, SLOW and WRONG-SERVICE are three different answers (mt#4149), and the
 * shared preflight keeps them apart. That matters most here: a latency baseline
 * taken against the wrong application is worse than none because it looks
 * authoritative, and one that silently did not run at all is worse still.
 */
await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

// --- Route discovery -----------------------------------------------------

/**
 * Detail routes need ids that actually exist. They are discovered from the API
 * rather than hardcoded so the script keeps working against any database — a
 * pinned id would turn "that task was closed" into a measurement failure.
 */
async function firstFrom<T>(
  path: string,
  pick: (body: T) => string | undefined
): Promise<string | undefined> {
  try {
    const res = await fetch(`${COCKPIT}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return undefined;
    return pick((await res.json()) as T);
  } catch {
    return undefined;
  }
}

/**
 * Only the fields discovery reads. Everything is optional because these are
 * probes against a live server, not a typed client — a shape change should
 * degrade to "route unavailable", not throw.
 */
interface TaskListBody {
  tasks?: Array<{ id?: string }>;
}
interface AskListBody {
  asks?: Array<{ id?: string }>;
}
interface AgentsWidgetBody {
  payload?: { agents?: Array<{ sessionId?: string; conversationId?: string }> };
}

const taskId = await firstFrom<TaskListBody>("/api/tasks", (b) => b?.tasks?.[0]?.id);
const askId = await firstFrom<AskListBody>("/api/asks", (b) => b?.asks?.[0]?.id);
// The agents widget wraps its rows in `payload`, unlike the bare-list routes
// above — verified against a live cockpit rather than assumed from the sibling
// endpoints' shape.
const agentId = await firstFrom<AgentsWidgetBody>(
  "/api/widget/agents/data",
  (b) => b?.payload?.agents?.[0]?.sessionId
);
const conversationId = await firstFrom<AgentsWidgetBody>(
  "/api/widget/agents/data",
  (b) => b?.payload?.agents?.find((a) => a?.conversationId)?.conversationId
);

interface RouteSpec {
  /** Human label for the report. */
  readonly label: string;
  /** SPA path to load. `undefined` marks a route whose id could not be discovered. */
  readonly path: string | undefined;
  /**
   * Path to start from when measuring a warm in-SPA navigation, plus how to
   * find the link to click. `undefined` means warm navigation is not measured
   * for this route (the home page has no "navigate to home from elsewhere"
   * gesture worth baselining).
   */
  readonly warmFrom?: string;
  /** Reason this route is unavailable, when `path` is undefined. */
  readonly unavailable?: string;
}

const ROUTES: RouteSpec[] = [
  { label: "home", path: "/" },
  { label: "tasks list", path: "/tasks", warmFrom: "/" },
  {
    label: "task detail",
    path: taskId ? `/tasks/${encodeURIComponent(taskId)}` : undefined,
    warmFrom: "/tasks",
    unavailable: taskId ? undefined : "no task returned by /api/tasks",
  },
  { label: "asks list", path: "/asks", warmFrom: "/" },
  {
    label: "ask detail",
    path: askId ? `/ask/${encodeURIComponent(askId)}` : undefined,
    warmFrom: "/asks",
    unavailable: askId ? undefined : "no ask returned by /api/asks",
  },
  { label: "agents list", path: "/agents", warmFrom: "/" },
  {
    label: "agent detail",
    path: agentId ? `/agents/${encodeURIComponent(agentId)}` : undefined,
    warmFrom: "/agents",
    unavailable: agentId ? undefined : "no agent returned by /api/widget/agents/data",
  },
  {
    label: "conversation",
    path: conversationId ? `/conversation/${encodeURIComponent(conversationId)}` : undefined,
    warmFrom: "/agents",
    unavailable: conversationId ? undefined : "no agent carried a conversationId",
  },
];

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
    // Latch + clear on every exit path so a late timer cannot reject an
    // already-settled promise.
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.removeEventListener("message", onMsg);
      reject(new Error(`CDP ${method} timed out`));
    }, 45_000);
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

async function evaluateJson<T>(ws: WebSocket, expression: string): Promise<T> {
  return JSON.parse(await evaluate(ws, expression)) as T;
}

// --- In-page expressions -------------------------------------------------

/**
 * Collected timings for one page state.
 *
 * `serverTiming` is per-request and only present when the route emitted a
 * `Server-Timing` header; an empty array means "the route emitted none", which
 * is a different and reportable fact from "the server was fast".
 */
interface ApiRequest {
  url: string;
  durationMs: number;
  transferBytes: number;
  serverTiming: Array<{ name: string; durationMs: number; description: string }>;
}

interface ColdSample {
  documentTtfbMs: number;
  domContentLoadedMs: number;
  loadEventEndMs: number;
  scriptFetchWallMs: number;
  scriptBytes: number;
  scriptCount: number;
  /**
   * Slowest single API request — the critical-path proxy. Reported instead of a
   * first-start-to-last-end wall span, which the cockpit's background pollers
   * inflate without bound: a span measured while a widget polls every few
   * seconds reports the polling interval, not the page's cost (measured: a
   * 15 s "api" figure for a page that loaded in well under two).
   */
  apiMaxMs: number;
  /** Sum of all API durations. Exceeds elapsed time when requests overlap. */
  apiSumMs: number;
  api: ApiRequest[];
  settleMs: number;
}

/**
 * Read the navigation + resource timeline.
 *
 * Script and API costs are reported as a WALL SPAN (last end minus first
 * start), not a sum of durations: the browser fetches these concurrently, so
 * summing durations double-counts overlap and can report more elapsed time
 * than the page actually took.
 */
const READ_COLD = `(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  const res = performance.getEntriesByType("resource");
  const span = (list) => list.length === 0 ? 0
    : Math.max(...list.map(e => e.responseEnd || e.startTime)) - Math.min(...list.map(e => e.startTime));
  const scripts = res.filter(e => e.initiatorType === "script" || /\\.js(\\?|$)/.test(e.name));
  const api = res.filter(e => e.name.includes("/api/"));
  return JSON.stringify({
    documentTtfbMs: nav ? nav.responseStart - nav.requestStart : 0,
    domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : 0,
    loadEventEndMs: nav ? nav.loadEventEnd : 0,
    scriptFetchWallMs: span(scripts),
    scriptBytes: scripts.reduce((n, e) => n + (e.encodedBodySize || 0), 0),
    scriptCount: scripts.length,
    apiMaxMs: api.length ? Math.max(...api.map(e => e.duration)) : 0,
    apiSumMs: api.reduce((n, e) => n + e.duration, 0),
    api: api.map(e => ({
      url: new URL(e.name).pathname,
      durationMs: e.duration,
      transferBytes: e.encodedBodySize || 0,
      serverTiming: (e.serverTiming || []).map(s => ({
        name: s.name, durationMs: s.duration, description: s.description,
      })),
    })),
  });
})()`;

/**
 * In-flight request tracking, installed via `Page.addScriptToEvaluateOnNewDocument`
 * so it runs BEFORE any page script and therefore before the app captures its
 * own reference to `fetch`.
 *
 * This exists because a DOM-only settle signal is not sufficient, and the first
 * version of this script proved it: the cockpit shell renders a skeleton with
 * non-empty text within ~100ms, so "has content and stopped changing" fired
 * before the page had issued the request whose latency is the entire point.
 * Task detail measured `api=0ms` — not "the API was fast" but "the measurement
 * ended before the API was called", which is exactly the failure mode that
 * would have made this baseline confidently wrong.
 */
const INSTALL_TRACKER = `(() => {
  if (window.__mt3696) return;
  const state = { inflight: 0, completed: 0, lastCompletedAt: 0 };
  window.__mt3696 = state;
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    state.inflight++;
    return originalFetch.apply(this, args).finally(() => {
      state.inflight--;
      state.completed++;
      state.lastCompletedAt = performance.now();
    });
  };
})()`;

interface SettleProbe {
  hasMain: boolean;
  textLength: number;
  nodeCount: number;
  path: string;
  inflight: number;
  completed: number;
  tracked: boolean;
}

const SETTLE_PROBE = `(() => {
  const main = document.querySelector("main");
  const s = window.__mt3696;
  return JSON.stringify({
    hasMain: !!main,
    textLength: main ? main.innerText.length : 0,
    nodeCount: main ? main.getElementsByTagName("*").length : 0,
    path: location.pathname,
    inflight: s ? s.inflight : 0,
    completed: s ? s.completed : 0,
    tracked: !!s,
  });
})()`;

/** Compare paths through decoding, so `/tasks/mt%233701` matches `/tasks/mt#3701`. */
function samePath(a: string, b: string): boolean {
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return decode(a) === decode(b);
}

/**
 * Wait until the page has arrived, finished fetching, and stopped rendering.
 *
 * Four conditions, each closing a hole the others leave open:
 *   - **arrived** — `location.pathname` matches the route being measured. Without
 *     this a warm navigation that never happened (a link that did not exist, or
 *     a click the router ignored) settles instantly on the ORIGIN page and
 *     reports its timings under the target's name. The first version of this
 *     script had exactly that bug.
 *   - **no in-flight requests** — the page is not still waiting on data.
 *   - **DOM stable** — data can arrive and still take a frame to render, and a
 *     page that finishes one request and immediately issues the next is not
 *     done. Measured by node count; see the comment at the key below for why
 *     not by text length or request count.
 *
 * `MIN_OBSERVE_MS` keeps the whole test from passing in the gap between mount
 * and the first effect, when there is genuinely nothing in flight yet.
 */
async function waitForSettle(ws: WebSocket, what: string, expectPath?: string): Promise<number> {
  const started = Date.now();
  let previous = "";
  let quiet = 0;

  while (Date.now() - started < SETTLE_DEADLINE_MS) {
    const probe = await evaluateJson<SettleProbe>(ws, SETTLE_PROBE);
    const arrived = expectPath === undefined || samePath(probe.path, expectPath);
    // Keyed on DOM node count, NOT on the completed-request count and NOT on
    // rendered text length. Both of those were tried and both make the cockpit
    // permanently unsettleable:
    //   - request count: widgets poll forever, so it never stops moving.
    //   - text length: the lists render relative timestamps ("3s ago"), which
    //     re-render on a timer, so the text changes indefinitely on a page that
    //     is completely finished loading. This is why `/tasks`, `/asks`,
    //     `/agents` and the conversation view all hit the deadline.
    // Node count is stable under both — a ticking label does not add elements,
    // while arriving data does. `textLength > 0` is still required below, as a
    // has-content gate rather than as a stability signal.
    const key = `${probe.hasMain}:${probe.nodeCount}:${probe.path}`;
    const ready =
      arrived &&
      probe.hasMain &&
      probe.textLength > 0 &&
      probe.inflight === 0 &&
      Date.now() - started >= MIN_OBSERVE_MS &&
      key === previous;

    if (ready) {
      if (++quiet >= SETTLE_QUIET_SAMPLES) return Date.now() - started;
    } else {
      quiet = 0;
    }
    previous = key;
    await sleep(SETTLE_INTERVAL_MS);
  }
  throw new Error(
    `${what}: page never settled within ${SETTLE_DEADLINE_MS}ms${
      expectPath ? ` (expected to be at ${expectPath})` : ""
    }`
  );
}

/** Find an in-SPA link to `path` and click it, returning whether one was found. */
function clickLinkExpression(path: string): string {
  return `(() => {
    const want = ${JSON.stringify(path)};
    const links = [...document.querySelectorAll("a[href]")];
    const hit = links.find(a => {
      try { return new URL(a.href, location.origin).pathname === want; } catch { return false; }
    });
    if (!hit) return "no-link";
    hit.click();
    return "clicked";
  })()`;
}

/**
 * Warm navigation is measured from the page's own clock, started immediately
 * before the click, so it excludes this script's CDP round-trip latency —
 * which is not something the operator experiences.
 */
const MARK_WARM_START = `(() => { window.__mt3696WarmStart = performance.now(); performance.clearResourceTimings(); return "ok"; })()`;

const READ_WARM = `(() => {
  const res = performance.getEntriesByType("resource");
  const api = res.filter(e => e.name.includes("/api/"));
  const scripts = res.filter(e => e.initiatorType === "script" || /\\.js(\\?|$)/.test(e.name));
  const span = (list) => list.length === 0 ? 0
    : Math.max(...list.map(e => e.responseEnd || e.startTime)) - Math.min(...list.map(e => e.startTime));
  return JSON.stringify({
    elapsedMs: performance.now() - (window.__mt3696WarmStart ?? performance.now()),
    apiMaxMs: api.length ? Math.max(...api.map(e => e.duration)) : 0,
    apiSumMs: api.reduce((n, e) => n + e.duration, 0),
    lazyChunkBytes: scripts.reduce((n, e) => n + (e.encodedBodySize || 0), 0),
    lazyChunkCount: scripts.length,
    api: api.map(e => ({
      url: new URL(e.name).pathname,
      durationMs: e.duration,
      transferBytes: e.encodedBodySize || 0,
      serverTiming: (e.serverTiming || []).map(s => ({
        name: s.name, durationMs: s.duration, description: s.description,
      })),
    })),
  });
})()`;

interface WarmSample {
  elapsedMs: number;
  apiMaxMs: number;
  apiSumMs: number;
  lazyChunkBytes: number;
  lazyChunkCount: number;
  api: ApiRequest[];
}

// --- Stats ---------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

const ms = (n: number) => `${n.toFixed(0)}ms`;
const stat = (values: number[]) =>
  values.length === 0
    ? "n/a"
    : `${ms(median(values))} (${ms(Math.min(...values))}–${ms(Math.max(...values))})`;

/** Sum the named server phase across a sample's API requests. */
function serverPhaseTotals(api: ApiRequest[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const req of api) {
    for (const phase of req.serverTiming) {
      totals[phase.name] = (totals[phase.name] ?? 0) + phase.durationMs;
    }
  }
  return totals;
}

// --- Run -----------------------------------------------------------------

const teardown: Array<() => Promise<unknown>> = [];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

let ws: WebSocket;
try {
  // PUT, not GET — required, not stylistic. Chrome rejects the GET form
  // outright: `GET /json/new?...` answers 405 with "Using unsafe HTTP verb GET
  // to invoke /json/new. This action supports only PUT verb." (verified against
  // Chrome/150.0.7871.187, the shared dev canary, 2026-08-04). Switching to GET
  // for looking more canonical would break this script (PR #2637 R1). The
  // sibling `verify-cockpit-shell-scroll.ts` uses PUT for the same reason.
  const newRes = await fetch(`${CDP}/json/new?${encodeURIComponent(`${COCKPIT}/`)}`, {
    method: "PUT",
  });
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

interface RouteResult {
  label: string;
  path: string | null;
  unavailable?: string;
  cold: ColdSample[];
  warm: WarmSample[];
  warmUnavailable?: string;
  /** Set when the page never reached a quiet state — a property of the page. */
  neverSettled?: string;
}

const results: RouteResult[] = [];
const failures: string[] = [];

async function navigateAndSettle(url: string, what: string, expectPath?: string): Promise<number> {
  await cdp(ws, "Page.navigate", { url });
  return waitForSettle(ws, what, expectPath);
}

async function measureRoute(route: RouteSpec): Promise<RouteResult> {
  const result: RouteResult = {
    label: route.label,
    path: route.path ?? null,
    cold: [],
    warm: [],
  };
  if (!route.path) {
    result.unavailable = route.unavailable ?? "route unavailable";
    return result;
  }

  for (let run = 0; run < RUNS; run++) {
    // Cold: a full document navigation. `about:blank` between runs forces a
    // genuine document load rather than a same-URL no-op.
    await cdp(ws, "Page.navigate", { url: "about:blank" });
    await sleep(150);
    const settleMs = await navigateAndSettle(
      `${COCKPIT}${route.path}`,
      `${route.label} cold run ${run + 1}`,
      route.path
    );
    const cold = await evaluateJson<Omit<ColdSample, "settleMs">>(ws, READ_COLD);
    result.cold.push({ ...cold, settleMs });

    // Warm: load the origin page, then click through to the target.
    if (route.warmFrom) {
      await cdp(ws, "Page.navigate", { url: "about:blank" });
      await sleep(150);
      await navigateAndSettle(
        `${COCKPIT}${route.warmFrom}`,
        `${route.label} warm origin ${route.warmFrom} run ${run + 1}`,
        route.warmFrom
      );
      await evaluate(ws, MARK_WARM_START);
      const clicked = await evaluate(ws, clickLinkExpression(route.path));
      if (clicked === "no-link") {
        result.warmUnavailable = `no in-SPA link to ${route.path} found on ${route.warmFrom}`;
        continue;
      }
      // Arrival is asserted, not assumed: a click the router ignores would
      // otherwise settle on the origin page and be reported as the target's.
      await waitForSettle(ws, `${route.label} warm run ${run + 1}`, route.path);
      result.warm.push(await evaluateJson<WarmSample>(ws, READ_WARM));
    }
  }
  return result;
}

try {
  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Page.enable");
  // Runs before any page script on EVERY subsequent document, which is the only
  // way to wrap `fetch` ahead of the app taking its own reference to it.
  await cdp(ws, "Page.addScriptToEvaluateOnNewDocument", { source: INSTALL_TRACKER });
  // The tab opened above already has a document, which the line above does not
  // retroactively cover.
  await evaluate(ws, INSTALL_TRACKER);
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    ...VIEWPORT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  console.log(`\nMeasuring ${ROUTES.length} routes x ${RUNS} run(s) against ${COCKPIT}\n`);
  for (const route of ROUTES) {
    try {
      const result = await measureRoute(route);
      results.push(result);
      if (result.unavailable) {
        console.log(`- ${result.label}: SKIPPED (${result.unavailable})`);
        continue;
      }
      console.log(`- ${result.label} (${result.path})`);
      if (result.cold.length > 0) {
        console.log(
          `    cold: settle=${stat(result.cold.map((c) => c.settleMs))} ` +
            `script=${stat(result.cold.map((c) => c.scriptFetchWallMs))} ` +
            `slowest-api=${stat(result.cold.map((c) => c.apiMaxMs))} ` +
            `bundle=${((result.cold[0]?.scriptBytes ?? 0) / 1024).toFixed(0)}KB/${result.cold[0]?.scriptCount ?? 0} files`
        );
      }
      if (result.warm.length > 0) {
        console.log(
          `    warm: nav=${stat(result.warm.map((w) => w.elapsedMs))} ` +
            `slowest-api=${stat(result.warm.map((w) => w.apiMaxMs))}`
        );
      } else if (result.warmUnavailable) {
        console.log(`    warm: not measured — ${result.warmUnavailable}`);
      }
      // Server phases, where the route emitted any.
      const phases = serverPhaseTotals([
        ...result.cold.flatMap((c) => c.api),
        ...result.warm.flatMap((w) => w.api),
      ]);
      const named = Object.entries(phases).filter(([n]) => n !== "total");
      if (named.length > 0) {
        const totalRuns = result.cold.length + result.warm.length || 1;
        // `total` is reported separately and FIRST because it is the number a
        // before/after comparison turns on: the per-phase figures barely move
        // when independent reads are de-serialized — what changes is whether
        // the handler costs their SUM or their MAX.
        const handlerTotal = phases["total"];
        console.log(
          `    server: ${handlerTotal !== undefined ? `total=${ms(handlerTotal / totalRuns)} | ` : ""}${named
            .sort((a, b) => b[1] - a[1])
            .map(([n, v]) => `${n}=${ms(v / totalRuns)}`)
            .join(" ")} (mean per page load)`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A page that never goes quiet is a FINDING about that page, not a broken
      // script — the conversation view live-tails, so "never settled" is a true
      // description of it. Exiting non-zero on that would make the baseline
      // unrunnable for exactly the surfaces most worth measuring. A CDP error is
      // the opposite: the measurement genuinely could not be taken.
      if (message.includes("never settled")) {
        results.push({
          label: route.label,
          path: route.path ?? null,
          cold: [],
          warm: [],
          neverSettled: message,
        });
        console.log(`- ${route.label}: NEVER SETTLED (reported, not a script failure)`);
        console.log(`    ${message}`);
      } else {
        failures.push(`${route.label}: ${message}`);
      }
    }
  }
} catch (err) {
  failures.push(`measurement error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await teardownAll();
}

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      cockpit: COCKPIT,
      runs: RUNS,
      viewport: VIEWPORT,
      measuredAt: new Date().toISOString(),
      results,
    },
    null,
    2
  )}\n`
);
console.log(`\nWrote ${OUT}`);

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} route(s) could not be measured:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("PASS: baseline captured. Slow numbers are the finding, not a failure.");
