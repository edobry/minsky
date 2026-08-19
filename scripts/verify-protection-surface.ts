#!/usr/bin/env bun
/**
 * The operator surface's vocabulary invariant, checked against a REAL render
 * over REAL data (mt#4287).
 *
 * `ProtectionPage.test.tsx` asserts the same invariant under happy-dom against
 * fixtures the test itself authored — which is exactly the shape that cannot
 * catch the regression that matters here. The banned vocabulary and the
 * interceptor names both arrive from the CATALOG at runtime, so a fixture with
 * three tidy classes proves nothing about the 135-entry corpus the operator
 * actually sees. A term can reach the DOM through a class the fixture never
 * included, and no unit test in this repo would notice.
 *
 * So this script reads the SERVED page's text and scans it against the live
 * catalog: every banned term, and every `guardName` the catalog declares. It
 * also captures a full-page screenshot, because the acceptance question for a
 * render path is one a human answers by looking (mt#2421) — and because a
 * screenshot the agent framed is an argument, not evidence, this one is
 * uncropped and full-page by construction (`humility.mdc §Subjective quality is
 * not yours to certify`).
 *
 * Usage:
 *   bun scripts/verify-protection-surface.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3841 bun scripts/verify-protection-surface.ts
 *
 * Prerequisites (each CHECKED at startup — a missing one exits 0 with `SKIP:`,
 * a present-but-slow one exits 2 with `INCOMPLETE:`, never a silent 0):
 *
 *   1. A running cockpit serving THIS worktree's bundle:
 *        bun run cockpit:build
 *        bun src/cli.ts cockpit start --port=<n>
 *      A cockpit started from `main` serves `main`'s build, not yours.
 *   2. A CDP endpoint at 127.0.0.1:9222 (the dev chromium the cockpit launches).
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default http://127.0.0.1:3737),
 * `MINSKY_CDP_URL` (default http://127.0.0.1:9222),
 * `MINSKY_PROTECTION_SHOT` (screenshot output path).
 *
 * Exits non-zero only on a real vocabulary violation. Sibling whose CDP shape
 * this follows: `scripts/verify-cockpit-shell-scroll.ts`.
 */
import { preflightCockpit } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const SHOT = process.env["MINSKY_PROTECTION_SHOT"] ?? "/tmp/mt4287-protection.png";

/** The route under test. A PLACEHOLDER path pending the naming ask (mt#4287 SC7). */
const ROUTE = "/protection";

/**
 * Banned on the operator surface (mt#4287 SC4).
 *
 * The first four are the live job — measured on the maintainer surface
 * 2026-08-19 at `canary` 18, `calibration` 6, `review-due` 3, `graduation` 3.
 * The rest were already at 0 there and are regression bars.
 */
const BANNED_TERMS = [
  "threshold",
  "false positive",
  "calibration",
  "review-due",
  "review due",
  "graduation",
  "canary",
  "flip/tune/keep",
  "deny-capable",
  "tuning ownership",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CdpResult = { result?: { value?: unknown }; exceptionDetails?: unknown };

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

async function evaluate<T>(ws: WebSocket, expression: string): Promise<T> {
  const r = await cdp(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value as T;
}

await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

/**
 * The live catalog's declared names — the second half of the scan.
 *
 * Read from the cockpit's own widget endpoint rather than the on-disk artifact:
 * the question is what the SERVED page could render, and the served page reads
 * the served catalog.
 */
const catalogRes = await fetch(`${COCKPIT}/api/widget/interceptors/data`);
const catalogBody = (await catalogRes.json()) as {
  state?: string;
  payload?: { entries?: Array<{ guardName: string }> };
};
const declaredNames = (catalogBody.payload?.entries ?? []).map((e) => e.guardName).filter(Boolean);
if (declaredNames.length === 0) {
  console.error("INCOMPLETE: the cockpit returned no catalog entries — nothing to scan against");
  process.exit(2);
}

const teardown: Array<() => Promise<unknown>> = [];
let ws: WebSocket;
try {
  const url = `${COCKPIT}${ROUTE}`;
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
  for (const step of teardown.reverse()) await step().catch(() => {});
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

await cdp(ws, "Emulation.setDeviceMetricsOverride", {
  width: 1100,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});

/**
 * Wait for the page to reach a TERMINAL state — rendered, pending, or errored.
 *
 * Waiting only for the rendered testid would hang for the full deadline on a
 * cockpit whose aggregates never arrive, and report that as a scan failure. The
 * three states mean different things and the script says which it got.
 */
const DEADLINE_MS = 30_000;
const STATE = `(() => {
  if (document.querySelector('[data-testid="protection-classes"]')) return "rendered";
  if (document.querySelector('[data-testid="protection-error"]')) return "error";
  if (document.querySelector('[data-testid="protection-pending"]')) return "pending";
  return "mounting";
})()`;

let state = "mounting";
const started = Date.now();
while (Date.now() - started < DEADLINE_MS) {
  state = await evaluate<string>(ws, STATE);
  if (state === "rendered" || state === "error") break;
  await sleep(500);
}

if (state !== "rendered") {
  // Not a vocabulary failure — say so rather than reporting a clean scan over
  // an empty page, which is the can't-fail-probe shape (mem#704).
  console.error(
    `INCOMPLETE: the page did not render its classes within ${DEADLINE_MS}ms (state: ${state}). ` +
      `No vocabulary conclusion is available from this run.`
  );
  for (const step of teardown.reverse()) await step().catch(() => {});
  process.exit(2);
}

const text = await evaluate<string>(ws, `document.body.innerText`);
const haystack = text.toLowerCase();

const bannedHits = BANNED_TERMS.filter((t) => haystack.includes(t));
const nameHits = declaredNames.filter((n) => text.includes(n));

// `CdpResult` models the Runtime.evaluate shape this file mostly uses;
// captureScreenshot returns `{ data }` instead, so read it through a narrowing
// check rather than casting the whole result to a different shape.
const shot: Record<string, unknown> = await cdp(ws, "Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: true,
});
const data = typeof shot["data"] === "string" ? shot["data"] : undefined;
if (data) {
  await Bun.write(SHOT, Buffer.from(data, "base64"));
}

for (const step of teardown.reverse()) await step().catch(() => {});

console.log(`route:            ${COCKPIT}${ROUTE}`);
console.log(`catalog entries:  ${declaredNames.length}`);
console.log(`rendered chars:   ${text.length}`);
console.log(`screenshot:       ${data ? SHOT : "(not captured)"}`);
console.log(`banned terms:     ${bannedHits.length === 0 ? "none" : bannedHits.join(", ")}`);
console.log(`interceptor names: ${nameHits.length === 0 ? "none" : nameHits.join(", ")}`);

if (bannedHits.length > 0 || nameHits.length > 0) {
  console.error("FAIL: maintainer vocabulary reached the operator surface.");
  process.exit(1);
}
console.log(
  "PASS: the operator surface carries no maintainer vocabulary and no interceptor names."
);
