#!/usr/bin/env bun
/**
 * Live-tail scroll behavior, verified in a real browser (mt#3376, mt#3445).
 *
 * Exercises what a zero-height test DOM cannot: a REAL scrollport (the driven
 * page's `overflow-y-auto` container, resolved the same way `findScrollParent`
 * resolves it — not the document fallback the component tests fall back to),
 * with content genuinely streaming into it while the reader is scrolled up.
 *
 * The discriminating case is mt#3445's: content growing INSIDE a turn that is
 * already rendered. The accumulator folds every streaming delta into one block
 * id, so the turn count holds still while the thread grows by hundreds of
 * pixels — which is why a component test keyed on rendered turns cannot see
 * this, and why the check asserts the count did NOT move.
 *
 * Assertions:
 *   1. The reader's scroll position does not move while content arrives.
 *   2. The return-to-newest control appears.
 *   3. It appeared on IN-PLACE growth (the turn count did not change).
 *   4. Clicking it returns to the newest content and dismisses it.
 *
 * Usage:
 *   bun scripts/verify-conversation-live-tail.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3839 bun scripts/verify-conversation-live-tail.ts
 *
 * Prerequisites (each is CHECKED at startup — a missing one exits 0 with a
 * `SKIP:` line rather than failing, so this is safe to run unattended. A
 * prerequisite that is PRESENT but too slow to answer is a DIFFERENT outcome:
 * `INCOMPLETE:` and exit 2, never a silent 0 — mt#4149):
 *
 *   1. A running cockpit, started WITHOUT `--no-dev-chromium` (that flag
 *      disables exactly the browser this attaches to):
 *
 *        bun run cockpit:build                    # prod bundle; HMR is unreliable here
 *        bun src/cli.ts cockpit start --port=3839
 *
 *      To verify a change that is not yet on `main`, run both from the SESSION
 *      workspace and point `MINSKY_COCKPIT_URL` at that port — a cockpit
 *      started from `main` serves `main`'s build, not yours.
 *
 *   2. A CDP endpoint at `127.0.0.1:9222` — the shared dev chromium the cockpit
 *      launches (`src/cockpit/dev-chromium.ts`). An instance already listening
 *      from another cockpit is reused; this opens its own tab and closes it on
 *      exit. Check with `curl -s localhost:9222/json/version`.
 *
 *   3. A cockpit auth token at `~/.local/state/minsky/cockpit-token`, written by
 *      the cockpit daemon on first start. No manual step.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`).
 *
 * Cost: SPAWNS a real `claude` process via the cockpit's driven-session API,
 * prompts it for a response long enough to stream as one turn, and stops it
 * again on exit. 30-60s and some tokens. That is inherent — the defect it
 * checks for does not exist in a test DOM, which has no height to grow.
 *
 * Exits non-zero only on a real behavioral failure. See also
 * `scripts/README.md` (§Running verify-conversation-live-tail.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { preflightCockpit, skip } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const TOKEN_PATH = join(homedir(), ".local/state/minsky/cockpit-token");
/**
 * How much the thread must overflow its scrollport before parking the reader at
 * the top counts as "scrolled up".
 *
 * Not arbitrary: `PINNED_THRESHOLD_PX` is 48, so with less than that much
 * overflow a reader at scrollTop=0 is STILL pinned by definition — there is
 * nothing meaningful to have scrolled up through — and the view correctly
 * follows the tail instead of offering to return to it. Parking as soon as the
 * thread merely overflows made this check pass or fail on whether streaming
 * happened to cross 48px in the sampling gap. 150 is three times the threshold,
 * about three seconds of streaming.
 */
const MIN_OVERFLOW_PX = 150;

/** Long enough to stream for a while as ONE turn — the case being verified. */
const PROMPT =
  "Write a numbered list of 40 one-line facts about text rendering. " +
  "One per line, no preamble, no summary.";

let token: string;
try {
  token = readFileSync(TOKEN_PATH, "utf-8").trim();
} catch {
  skip(`no cockpit token at ${TOKEN_PATH}`);
}

/**
 * ABSENT, SLOW and WRONG-SERVICE are three different answers (mt#4149), and the
 * shared preflight keeps them apart: a missing cockpit is a `SKIP:` + exit 0, a
 * present-but-over-budget one exits non-zero rather than printing the same line.
 *
 * This also moves the probe from `/health` to `/api/health` and asserts the
 * `service` field. `/health` falls through to the SPA's index.html and answers
 * 200 with HTML, so the old check here could not fail on a wrong service — it
 * passed against anything serving a page at all.
 */
await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

const authHeaders = {
  "Content-Type": "application/json",
  Cookie: `minsky_cockpit=${token}`,
  Authorization: `Bearer ${token}`,
};

/** The subset of a CDP `Runtime.evaluate` reply this script reads. */
type CdpResult = {
  result?: { value?: string };
  exceptionDetails?: unknown;
};

/** One sample of the thread's geometry, as read in-page by {@link READ}. */
type ThreadState = {
  usedDocumentFallback: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollable: boolean;
  turns: number;
  jumpVisible: boolean;
};

let msgId = 0;
function cdp(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {}
): Promise<CdpResult> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    // Clear the deadline on every exit path, and latch so a late timer cannot
    // reject a promise that already settled: this runs one CDP call per second
    // for minutes over a single socket, so an uncleared 30s timer per call
    // would pile up and start firing spurious rejections mid-run.
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

/** Read the thread's geometry out of the page. */
async function readState(ws: WebSocket): Promise<ThreadState> {
  return JSON.parse(await evaluate(ws, READ)) as ThreadState;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve the scrollport the component itself resolved — same rule as `findScrollParent`.
 *
 * Anchored on the thread's own testid, the app-owned handle added for exactly
 * this purpose (PR #2693 R1). It used to start from the `scroll-mb-8` sentinel,
 * which is a CLASS FRAGMENT and therefore breaks silently on any unrelated
 * markup change — and a geometry check that cannot find its scrollport falls
 * back to a non-scrolling `document.scrollingElement` and reports a measurement
 * rather than a failure. `verify-conversation-turn-target.ts` already used the
 * testid; mt#3843 brought the remaining sibling scripts onto it so all of them
 * resolve the same element the same way.
 */
const RESOLVE_PORT = `
  let port = document.querySelector('[data-testid="conversation-thread"]');
  while (port) {
    const s = getComputedStyle(port);
    const scrolls = ["auto","scroll","overlay"].includes(s.overflowY) || ["auto","scroll","overlay"].includes(s.overflow);
    if (scrolls && port.scrollHeight > port.clientHeight) break;
    port = port.parentElement;
  }
  const el = port || document.scrollingElement;`;

const READ = `(() => {${RESOLVE_PORT}
  return JSON.stringify({
    usedDocumentFallback: !port,
    scrollTop: Math.round(el.scrollTop),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollable: el.scrollHeight > el.clientHeight,
    turns: document.querySelectorAll('[data-testid="turn-role-label"]').length,
    jumpVisible: !!document.querySelector('[data-testid="jump-to-newest"]'),
  });
})()`;

const SCROLL_TO_TOP = `(() => {${RESOLVE_PORT}
  el.scrollTop = 0;
  el.dispatchEvent(new Event("scroll"));
  return "ok";
})()`;

const spawnRes = await fetch(`${COCKPIT}/api/driven-session`, {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ cwd: "/tmp" }),
});
const session = (await spawnRes.json()) as { sessionId?: string };
if (!session.sessionId) {
  console.error(`FAIL: spawn refused: ${JSON.stringify(session)}`);
  process.exit(1);
}
console.log(`spawned ${session.sessionId}`);

/**
 * Everything that must be torn down, registered as it is acquired.
 *
 * The driven session is a REAL `claude` process, so leaking one is not a tidy
 * -up nicety — the most likely failure (the CDP socket never opening) happens
 * AFTER the spawn, which is exactly when a try/finally placed further down
 * would not yet be covering it.
 */
const teardown: Array<() => Promise<unknown>> = [
  () =>
    fetch(`${COCKPIT}/api/driven-session/${session.sessionId}/stop`, {
      method: "POST",
      headers: authHeaders,
    }),
];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

const url = `${COCKPIT}/driven/${session.sessionId}?compose=${encodeURIComponent(PROMPT)}`;
let ws: WebSocket;
try {
  const newRes = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
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
  console.error(`FAIL: could not attach to the browser: ${String(err)}`);
  process.exit(1);
}

const failures: string[] = [];
const results: Record<string, unknown> = { cockpit: COCKPIT, sessionId: session.sessionId };
try {
  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Wait until the thread overflows its container by enough that parking at the
  // top is genuinely "scrolled up" — see MIN_OVERFLOW_PX.
  let state: ThreadState | null = null;
  for (let i = 0; i < 120; i++) {
    state = await readState(ws);
    if (state.scrollHeight - state.clientHeight > MIN_OVERFLOW_PX && state.turns >= 2) break;
    await sleep(1000);
  }
  const overflow = state ? state.scrollHeight - state.clientHeight : 0;
  results["overflowAtPark"] = overflow;
  if (overflow <= MIN_OVERFLOW_PX) {
    // Recorded, not `process.exit` — exiting here would skip the teardown
    // below and leave a real `claude` process running.
    failures.push(
      `the thread never overflowed by more than ${MIN_OVERFLOW_PX}px, so "scrolled up" was ` +
        `never a distinct state from "pinned": ${JSON.stringify(state)}`
    );
  }
  results["scrollportResolved"] = state?.usedDocumentFallback ? "document-fallback" : "container";
  console.log(
    `\nscrollport resolved: ${state?.usedDocumentFallback ? "document fallback" : "CONTAINER"}`
  );
  console.log(`geometry: ${JSON.stringify(state)}`);
  if (state?.usedDocumentFallback) {
    failures.push("resolved the document fallback — the container path was not exercised");
  }

  // Park at the top, as an operator reading history would be.
  await evaluate(ws, SCROLL_TO_TOP);
  const parked = await readState(ws);
  results["parked"] = parked;
  console.log(`\nparked at top: scrollTop=${parked.scrollTop}, turns=${parked.turns}`);

  // Let more content stream in.
  let after: ThreadState = parked;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    after = await readState(ws);
    if (after.scrollHeight > parked.scrollHeight + 200) break;
  }
  results["after"] = after;
  console.log(
    `after streaming: scrollTop=${after.scrollTop}, scrollHeight ${parked.scrollHeight} -> ${after.scrollHeight}, turns ${parked.turns} -> ${after.turns}, jumpVisible=${after.jumpVisible}`
  );

  if (after.scrollHeight <= parked.scrollHeight) {
    failures.push("no new content arrived while parked — the case was never exercised");
  }
  if (after.scrollTop !== parked.scrollTop) {
    failures.push(`scroll position MOVED while reading: ${parked.scrollTop} -> ${after.scrollTop}`);
  }
  if (!after.jumpVisible) failures.push("no return-to-newest control appeared");

  // mt#3445's discriminator. A control that only appears once a NEW turn lands
  // is the behavior mt#3376 already had; the defect is the silence BEFORE that.
  const inPlace = after.turns === parked.turns;
  results["grewInPlace"] = inPlace;
  if (!inPlace) {
    failures.push(
      `growth was not in-place (turns ${parked.turns} -> ${after.turns}) — a new turn landed first, ` +
        "so this run did not discriminate mt#3445. Re-run; the prompt should stream as one long turn."
    );
  }

  // The control returns to the newest content and dismisses itself.
  if (after.jumpVisible) {
    await evaluate(ws, `document.querySelector('[data-testid="jump-to-newest"]').click(), "ok"`);
    await sleep(1200);
    const jumped = await readState(ws);
    results["afterClick"] = jumped;
    console.log(`after clicking: scrollTop=${jumped.scrollTop}, jumpVisible=${jumped.jumpVisible}`);
    if (jumped.scrollTop <= parked.scrollTop) {
      failures.push("the control did not scroll back toward the newest content");
    }
    // A hard assertion, and a load-bearing one: the control coming back while
    // the same turn keeps streaming was the visible symptom of the scrollport
    // being resolved to an element that does not scroll (mt#3445). If this
    // starts failing again, suspect the resolution, not the affordance.
    if (jumped.jumpVisible) failures.push("the control did not stay dismissed after being clicked");
  }
} finally {
  await teardownAll();
}

results["failures"] = failures;
console.log(`\nRESULTS ${JSON.stringify(results)}`);
if (failures.length) {
  console.error(`\nFAIL:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(
  "\nPASS: position held while reading, the control appeared on IN-PLACE growth, and it returns to newest."
);
