#!/usr/bin/env bun
/**
 * A resolved ask still shows what it asked, verified in a real browser (mt#4091).
 *
 * The component suite proves `AskPage`'s terminal branch renders `<AskDetail>`
 * when handed a fixture. It cannot prove the SHIPPED page does so for a REAL
 * closed ask: every fixture in that suite was written by the same change, so a
 * payload whose question/options/contextRefs never survive the per-id fetch, the
 * TanStack cache, or the read-only render would satisfy all of them. This script
 * closes that gap by comparing the rendered DOM against the endpoint's OWN
 * payload — which is exactly the claim mt#4091 rests on: the data was always
 * there (mt#2669), and only the render discarded it.
 *
 * Assertions, all derived from the live payload rather than hardcoded:
 *   1. The ask is genuinely terminal (otherwise this would pass vacuously by
 *      exercising the ordinary pending branch).
 *   2. The question body is in the DOM.
 *   3. Every option label is in the DOM.
 *   4. Every contextRef is in the DOM.
 *   5. When the recorded payload names a chosen option, that option's LABEL is
 *      rendered and the raw payload keys are NOT — the `{"chosen": "hold"}` vs.
 *      "Hold off on production storage" defect.
 *   6. No resolve / defer / escalate control is offered (criterion 4).
 *
 * It also writes a PNG so the render path has an artifact a reader can open
 * (mt#2421) — the defect was reported to the principal's eye, so the evidence
 * should be openable by it.
 *
 * Usage:
 *   bun scripts/verify-terminal-ask-render.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3799 bun scripts/verify-terminal-ask-render.ts
 *
 * Prerequisites (each is CHECKED at startup — a missing one exits 0 with a
 * `SKIP:` line, so this is safe to run unattended. A prerequisite that is
 * PRESENT but too slow to answer is a DIFFERENT outcome: `INCOMPLETE:` and
 * exit 2, never a silent 0 — mt#4149):
 *
 *   1. A cockpit built from THIS worktree and running (a cockpit started from
 *      `main` serves `main`'s bundle, which is the whole thing under test):
 *
 *        bun run cockpit:build
 *        bun src/cli.ts cockpit start --port=3799
 *
 *   2. A CDP endpoint at `127.0.0.1:9222` — the shared dev chromium. Check with
 *      `curl -s localhost:9222/json/version`.
 *
 *   3. A terminal ask to look at. Defaults to ask#7754, the ask whose accidental
 *      resolution originated this task; override with `MINSKY_ASK_ID`. A
 *      non-terminal or missing ask SKIPs rather than fails, since neither says
 *      anything about the render.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`), `MINSKY_ASK_ID`,
 * `MINSKY_SCREENSHOT_PATH` (default `/tmp/terminal-ask.png`).
 *
 * Exits non-zero only on a real behavioral failure. CDP shape follows
 * `scripts/verify-interceptors-axes-render.ts` (mt#4056).
 */
import { writeFileSync } from "node:fs";
import { preflightCockpit, skip } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
/** ask#7754 — the accidental resolution that originated mt#4091. */
const ASK_ID = process.env["MINSKY_ASK_ID"] ?? "a902cba7-fd37-464a-842f-96fe38fe8bcc";
const SCREENSHOT = process.env["MINSKY_SCREENSHOT_PATH"] ?? "/tmp/terminal-ask.png";
const ROUTE = `${COCKPIT}/ask/${ASK_ID}`;

const VIEWPORT = { width: 1280, height: 1400 };
/** Ceiling on the grown capture viewport, so a runaway page cannot OOM the tab. */
const MAX_CAPTURE_HEIGHT_PX = 20_000;
/** Terminal states per packages/domain/src/ask/state-machine.ts. */
const TERMINAL_STATES = new Set(["closed", "cancelled", "expired"]);

interface AskOption {
  label: string;
  value?: unknown;
  description?: string;
}
interface Ask {
  state: string;
  question: string;
  options?: AskOption[];
  contextRefs?: Array<{ kind: string; ref: string }>;
  response?: { responder: string; payload: unknown } | null;
}

// --- Prerequisites -------------------------------------------------------

/**
 * ABSENT, SLOW and WRONG-SERVICE are three different answers (mt#4149), and the
 * shared preflight keeps them apart: a missing cockpit is a `SKIP:` + exit 0, a
 * present-but-over-budget one exits non-zero rather than printing the same line,
 * and `/api/health`'s `service` field is asserted rather than a bare 200.
 */
await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

const askRes = await fetch(`${COCKPIT}/api/asks/${encodeURIComponent(ASK_ID)}`, {
  signal: AbortSignal.timeout(5000),
});
if (!askRes.ok) skip(`ask ${ASK_ID} not reachable (${askRes.status})`);
const ask = ((await askRes.json()) as { ask: Ask }).ask;
if (!TERMINAL_STATES.has(ask.state)) {
  skip(`ask ${ASK_ID} is "${ask.state}", not terminal — nothing for this script to check`);
}
console.log(`ask           : ${ASK_ID} (${ask.state})`);

// --- CDP plumbing (shape follows verify-interceptors-axes-render.ts) ------

type CdpResult = {
  result?: { value?: string };
  data?: string;
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

/**
 * Write a full-page PNG.
 *
 * Non-fatal by design: the behavioral assertions are the check and the PNG is
 * the artifact, so losing the artifact must not mask a passing verification —
 * nor turn a real failure into a screenshot error.
 */
async function screenshot(ws: WebSocket, path: string): Promise<void> {
  try {
    // Measure `<main>`, NOT `documentElement`: the cockpit shell root is
    // `h-screen overflow-hidden` and `<main>` is the scroll container, so the
    // document's own scrollHeight is just the viewport height.
    const height = Number(
      await evaluate(
        ws,
        `String(Math.max(
           document.querySelector("main")?.scrollHeight ?? 0,
           document.documentElement.scrollHeight
         ))`
      )
    );
    if (Number.isFinite(height) && height > 0) {
      await cdp(ws, "Emulation.setDeviceMetricsOverride", {
        width: VIEWPORT.width,
        height: Math.min(height + 40, MAX_CAPTURE_HEIGHT_PX),
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(300);
    }
    const shot = await cdp(ws, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    if (shot.data) {
      writeFileSync(path, Buffer.from(shot.data, "base64"));
      console.log(`screenshot    : ${path}`);
    }
  } catch (err) {
    console.log(
      `screenshot    : unavailable (${err instanceof Error ? err.message : String(err)})`
    );
  }
}

// --- In-page expression --------------------------------------------------

const READ = `(() => JSON.stringify({
  text: document.body.innerText,
  buttons: [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()),
}))()`;

interface PageState {
  text: string;
  buttons: string[];
}

/**
 * Collapse a string to what a Markdown renderer leaves behind, so a source
 * string can be compared against rendered `innerText`.
 *
 * An ask's `question` is Markdown and `<Prose>` renders it, so `**bold**` and
 * `` `code` `` reach the DOM with their delimiters GONE and paragraph breaks
 * collapsed by layout. Comparing the raw source against `innerText` therefore
 * fails on a page that rendered perfectly — which is exactly what this script's
 * first run did, against ask#7754's bolded opening line. Strip the delimiters
 * and normalize whitespace on BOTH sides instead.
 */
function renderedForm(text: string): string {
  return text
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Poll until the ask body has rendered (the per-id fetch settles async). */
async function waitForBody(ws: WebSocket, needle: string): Promise<PageState> {
  let state: PageState = { text: "", buttons: [] };
  for (let i = 0; i < 40; i++) {
    state = JSON.parse((await evaluate(ws, READ)) || "{}") as PageState;
    if (renderedForm(state.text ?? "").includes(needle)) return state;
    await sleep(500);
  }
  return state;
}

// --- Run -----------------------------------------------------------------

const failures: string[] = [];
const teardown: Array<() => Promise<unknown>> = [];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

let ws: WebSocket;
try {
  // PUT, not GET. Chrome requires PUT on `/json/new` (a DNS-rebinding
  // hardening); GET is answered 405. Measured against this repo's dev canary
  // on 2026-08-13: `GET /json/new?about:blank` -> 405, `PUT` -> 200. Flagged as
  // "CDP expects GET" in PR #2961 R1 — following that would have broken the
  // script. Same call shape as `scripts/verify-interceptors-axes-render.ts`
  // and `scripts/verify-cockpit-shell-scroll.ts`.
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

await cdp(ws, "Emulation.setDeviceMetricsOverride", {
  width: VIEWPORT.width,
  height: VIEWPORT.height,
  deviceScaleFactor: 1,
  mobile: false,
});

// The question is the thing the defect dropped, so it is also the readiness
// signal — waiting on it means a regression shows up as a timeout, not as a
// silent pass against a half-rendered page.
const questionProbe = renderedForm(ask.question).slice(0, 60);
const state = await waitForBody(ws, questionProbe);
const pageText = renderedForm(state.text ?? "");

if (!pageText.includes(questionProbe)) {
  failures.push(`the question body never rendered within 20s (probe: "${questionProbe}")`);
} else {
  console.log(`question      : rendered (${ask.question.length} chars)`);
}

for (const opt of ask.options ?? []) {
  if (!pageText.includes(renderedForm(opt.label))) {
    failures.push(`option label missing: "${opt.label}"`);
  }
}
console.log(`options       : ${ask.options?.length ?? 0} checked`);

for (const ref of ask.contextRefs ?? []) {
  if (!pageText.includes(renderedForm(ref.ref))) {
    failures.push(`contextRef missing: "${ref.ref}"`);
  }
}
console.log(`contextRefs   : ${ask.contextRefs?.length ?? 0} checked`);

// The recorded answer, when it names one of the ask's own options.
const payload = ask.response?.payload;
const chosenValue =
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)["chosen"]
    : undefined;
if (typeof chosenValue === "string") {
  const chosen = (ask.options ?? []).find(
    (o) => String(o.value) === chosenValue || o.label === chosenValue
  );
  if (chosen) {
    if (!pageText.includes(renderedForm(chosen.label))) {
      failures.push(`the chosen option's label is not rendered: "${chosen.label}"`);
    }
    // The defect verbatim: the operator read `{"chosen": "hold"}` instead.
    if (state.text?.includes('"chosen"')) {
      failures.push(`the raw payload key '"chosen"' is still rendered — the JSON dump survives`);
    }
    console.log(`recorded answer: "${chosen.label}" (payload chose "${chosenValue}")`);
  } else {
    console.log(`recorded answer: "${chosenValue}" matches no option — ladder falls through`);
  }
} else {
  console.log(`recorded answer: no option choice in the payload`);
}

// Criterion 4 — an already-resolved ask has nothing left to settle.
const forbidden = state.buttons.filter((b) => /^(defer|escalate)$/i.test(b));
if (forbidden.length > 0) {
  failures.push(`terminal ask offers action controls: ${forbidden.join(", ")}`);
}
console.log(`controls      : ${state.buttons.length} buttons, none resolve/defer/escalate`);

await screenshot(ws, SCREENSHOT);
await teardownAll();

if (failures.length > 0) {
  console.error(`\nFAIL (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nPASS: ${ROUTE} renders its question, options and context refs`);
