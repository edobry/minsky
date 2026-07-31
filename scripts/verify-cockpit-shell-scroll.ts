#!/usr/bin/env bun
/**
 * Cockpit shell scroll invariant, verified in a real browser (mt#3335, mt#3338).
 *
 * The component suite runs under happy-dom, which has no layout engine: every
 * `clientHeight` / `scrollHeight` / `getBoundingClientRect()` reads 0, so the
 * behavioral form of this check cannot be written there. `Layout.test.tsx`
 * asserts the Tailwind classes that PRODUCED correct geometry at the time they
 * were verified — a surrogate that cannot catch a regression which leaves the
 * classes intact and breaks the geometry anyway (a new wrapper element between
 * the root and the scroller, a changed breakpoint, an ancestor that starts
 * clipping). This script closes that gap by measuring the real box model.
 *
 * The invariant (mt#3335): below the `md` breakpoint the shell root is
 * `flex-col`, which makes the workspace column a COLUMN-flex item whose
 * automatic minimum size is its own content height. Without `min-h-0` it cannot
 * shrink, `<main>` is handed full content height instead of the leftover space,
 * never becomes a scroller, and the root's `overflow-hidden` clips everything
 * below the fold with no way to reach it — narrow windows could not scroll AT
 * ALL. Above `md` the same div is a ROW-flex item and `<main>`, already a scroll
 * container, shrinks correctly, which is why the defect was invisible at normal
 * widths.
 *
 * Assertions (all at a sub-`md` viewport, against deterministically injected
 * overflow):
 *   1. `<main>` fits within the viewport — it is sized by leftover space, not by
 *      its content. This is the assertion that fails without `min-h-0`.
 *   2. `<main>` is a real scroller: `scrollHeight > clientHeight`.
 *   3. Trailing content is reachable — scrolling to the bottom brings the tail
 *      of the injected probe into the viewport.
 *   4. Control: at a desktop (`md`+) viewport the same three hold, confirming
 *      the check is not merely detecting "narrow windows are broken".
 *
 * Why inject overflow rather than navigate to a content-heavy route: the defect
 * is a property of the SHELL, not of any page's data volume. Injecting a tall
 * child makes the check deterministic — it neither passes nor fails on how many
 * tasks happen to exist when it runs.
 *
 * Usage:
 *   bun scripts/verify-cockpit-shell-scroll.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3839 bun scripts/verify-cockpit-shell-scroll.ts
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
 *      from `main` serves `main`'s build, not yours. This script asserts the
 *      served bundle's identity but cannot tell which WORKTREE built it.
 *
 *   2. A CDP endpoint at `127.0.0.1:9222` — the shared dev chromium the cockpit
 *      launches (`src/cockpit/dev-chromium.ts`). An instance already listening
 *      from another cockpit is reused; this opens its own tab and closes it on
 *      exit. Check with `curl -s localhost:9222/json/version`.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`).
 *
 * Cost: opens one tab, injects a div, measures, closes. No process spawn, no
 * tokens, a few seconds.
 *
 * Exits non-zero only on a real behavioral failure. Sibling:
 * `scripts/verify-conversation-live-tail.ts` (mt#3376/mt#3445), whose CDP shape
 * this follows.
 */
import {
  assertServiceIdentity,
  describeHealthIdentityResult,
  SERVICE_IDENTITIES,
} from "../packages/domain/src/deployment/health-identity";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";

/**
 * Viewports. `md` is Tailwind's 768px; 700 is comfortably below it so the root
 * is `flex-col` (the defect's regime), 1100 comfortably above so it is
 * `flex-row` (the control).
 */
const NARROW = { width: 700, height: 900 };
const WIDE = { width: 1100, height: 900 };

/** Tall enough to overflow either viewport by a wide margin. */
const PROBE_HEIGHT_PX = 3000;
const PROBE_ID = "mt3338-overflow-probe";

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
 * check pass and the identity parse below throw. Verified 2026-07-31 against a
 * running cockpit; the route is mounted by `src/cockpit/routes/health.ts`.
 */
const HEALTH = `${COCKPIT}/api/health`;

if (!(await reachable(HEALTH))) skip(`no cockpit reachable at ${COCKPIT}`);
if (!(await reachable(`${CDP}/json/version`))) skip(`no CDP endpoint at ${CDP}`);

/**
 * Assert WHICH service answered, not merely that something did (mt#3148).
 * Every Minsky service is built from the same monorepo, so a misconfigured
 * build can put a different application on this port and it will answer 200
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

// --- CDP plumbing (shape follows verify-conversation-live-tail.ts) --------

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

/**
 * Install a fixed-height child inside `<main>`, idempotently. Returns "ok", or
 * "no-main" if the shell never rendered (a bad route or a build that failed to
 * boot) — distinguished so the caller reports the right failure.
 */
const INSTALL_PROBE = `(() => {
  const main = document.querySelector("main");
  if (!main) return "no-main";
  let probe = document.getElementById(${JSON.stringify(PROBE_ID)});
  if (!probe) {
    probe = document.createElement("div");
    probe.id = ${JSON.stringify(PROBE_ID)};
    main.appendChild(probe);
  }
  probe.style.height = ${JSON.stringify(`${PROBE_HEIGHT_PX}px`)};
  probe.style.flex = "none";
  probe.textContent = "";
  const tail = document.createElement("div");
  tail.id = ${JSON.stringify(`${PROBE_ID}-tail`)};
  tail.textContent = "TAIL";
  tail.style.position = "absolute";
  tail.style.bottom = "0";
  probe.style.position = "relative";
  probe.appendChild(tail);
  return "ok";
})()`;

const REMOVE_PROBE = `(() => {
  document.getElementById(${JSON.stringify(PROBE_ID)})?.remove();
  return "ok";
})()`;

type ShellState = {
  hasMain: boolean;
  innerHeight: number;
  mainClientHeight: number;
  mainScrollHeight: number;
  mainScrollTop: number;
  maxScrollTop: number;
  rootOverflowY: string;
};

const READ = `(() => {
  const main = document.querySelector("main");
  if (!main) return JSON.stringify({ hasMain: false });
  const root = main.closest("div.h-screen") || document.body;
  return JSON.stringify({
    hasMain: true,
    innerHeight: window.innerHeight,
    mainClientHeight: main.clientHeight,
    mainScrollHeight: main.scrollHeight,
    mainScrollTop: Math.round(main.scrollTop),
    maxScrollTop: main.scrollHeight - main.clientHeight,
    rootOverflowY: getComputedStyle(root).overflowY,
  });
})()`;

const SCROLL_TO_BOTTOM = `(() => {
  const main = document.querySelector("main");
  if (!main) return "no-main";
  main.scrollTop = main.scrollHeight;
  return "ok";
})()`;

/** Is the probe's tail inside the viewport right now? */
const TAIL_VISIBLE = `(() => {
  const tail = document.getElementById(${JSON.stringify(`${PROBE_ID}-tail`)});
  if (!tail) return "false";
  const r = tail.getBoundingClientRect();
  return String(r.top >= 0 && r.bottom <= window.innerHeight + 1);
})()`;

// --- Run -----------------------------------------------------------------

const failures: string[] = [];
const teardown: Array<() => Promise<unknown>> = [];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

let ws: WebSocket;
try {
  const newRes = await fetch(`${CDP}/json/new?${encodeURIComponent(COCKPIT)}`, { method: "PUT" });
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

/** Measure the shell at one viewport. Appends to {@link failures}. */
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
  // One frame for the flex layout to settle after the metrics change.
  await sleep(400);

  const installed = await evaluate(ws, INSTALL_PROBE);
  if (installed === "no-main") {
    failures.push(
      `${label}: the shell never rendered a <main> — bad route, or the bundle failed to boot`
    );
    return;
  }
  await sleep(300);

  const s = JSON.parse(await evaluate(ws, READ)) as ShellState;
  if (!s.hasMain) {
    failures.push(`${label}: <main> disappeared between installing the probe and measuring`);
    return;
  }

  console.log(
    `${label} (${width}x${height}): innerHeight=${s.innerHeight} ` +
      `main.clientHeight=${s.mainClientHeight} main.scrollHeight=${s.mainScrollHeight} ` +
      `maxScrollTop=${s.maxScrollTop} root.overflowY=${s.rootOverflowY}`
  );

  // 1. Sized by leftover space, not by content. This is the assertion that
  //    fails without `min-h-0`: main is handed the full content height, so its
  //    clientHeight balloons past the viewport.
  if (s.mainClientHeight > s.innerHeight) {
    failures.push(
      `${label}: <main> is taller than the viewport (clientHeight=${s.mainClientHeight} > innerHeight=${s.innerHeight}) — ` +
        `it is sized by its content instead of the leftover space, so the shell cannot scroll it`
    );
  }

  // 2. Actually a scroller.
  if (!(s.mainScrollHeight > s.mainClientHeight)) {
    failures.push(
      `${label}: <main> is not a scroller (scrollHeight=${s.mainScrollHeight} <= clientHeight=${s.mainClientHeight}) ` +
        `despite ${PROBE_HEIGHT_PX}px of injected content`
    );
  }

  // 3. Trailing content is reachable.
  await evaluate(ws, SCROLL_TO_BOTTOM);
  await sleep(300);
  const after = JSON.parse(await evaluate(ws, READ)) as ShellState;
  const tailVisible = (await evaluate(ws, TAIL_VISIBLE)) === "true";
  if (after.mainScrollTop <= 0) {
    failures.push(
      `${label}: scrolling <main> to the bottom left scrollTop at ${after.mainScrollTop} — it did not scroll`
    );
  }
  if (!tailVisible) {
    failures.push(
      `${label}: the tail of the injected content is not reachable after scrolling to the bottom`
    );
  }

  await evaluate(ws, REMOVE_PROBE);
}

try {
  await checkViewport("narrow (sub-md, the mt#3335 regime)", NARROW);
  await checkViewport("wide (md+, control)", WIDE);
} catch (err) {
  failures.push(`measurement error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await teardownAll();
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} shell-scroll assertion(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  "\nPASS: the cockpit shell scrolls at both viewports, and trailing content is reachable."
);
