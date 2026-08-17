#!/usr/bin/env bun
/**
 * Conversation-view visual weight, measured in a real browser (mt#4220).
 *
 * `ConversationView.weight-hierarchy.test.tsx` pins the CSS SHAPE — which
 * Tailwind classes each element carries. It runs under happy-dom, which has
 * neither a layout engine nor a CSS cascade: `getBoundingClientRect()` reads 0
 * and `getComputedStyle()` never resolves `text-muted-foreground` to a colour.
 * So the class assertions are compatible with a bundle where the classes are
 * present and the rendered result is unchanged — a Tailwind purge that dropped
 * the utility, a later rule winning the cascade, a `cn()` that stopped merging.
 *
 * This script closes that gap by measuring what the browser actually painted:
 *
 *   1. **Rendered thread height + element counts.** The before/after number
 *      mt#4220 SC7 asks for. Counts are reported alongside so a height drop is
 *      attributable to weight rather than to content going missing — a shorter
 *      thread with fewer elements is a REGRESSION, not a win.
 *   2. **Computed colour separation.** Assistant prose must paint BRIGHTER than
 *      a healthy tool row's name. This is the hierarchy itself, and it is the
 *      one assertion no component test can make.
 *   3. **Enclosure count.** How many tool rows paint a visible border. After
 *      mt#4220 that should equal the number of ERRORED rows — every healthy row
 *      is a bare line.
 *
 * Usage:
 *   MINSKY_CONVERSATION_ID=<agent-session-uuid> bun scripts/verify-conversation-weight.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3839 MINSKY_CONVERSATION_ID=… bun scripts/verify-conversation-weight.ts
 *
 * Pick a conversation with a long run of tool calls — that is the shape the
 * complaint was about, and a prose-only conversation exercises nothing here.
 *
 * Prerequisites (each CHECKED at startup; a missing one exits 0 with a `SKIP:`
 * line, so this is safe to run unattended):
 *
 *   1. A running cockpit started WITHOUT `--no-dev-chromium`:
 *
 *        bun run cockpit:build                     # prod bundle; HMR is unreliable here
 *        bun src/cli.ts cockpit start --port=3839
 *
 *      To measure a change that is not yet on `main`, run BOTH from the SESSION
 *      workspace and point `MINSKY_COCKPIT_URL` at that port — a cockpit started
 *      from `main` serves `main`'s build, not yours.
 *   2. A CDP endpoint at `127.0.0.1:9222` (the shared dev chromium).
 *   3. `MINSKY_CONVERSATION_ID` — no default. Deliberately required rather than
 *      discovered: there is no conversation-LIST endpoint on the cockpit API
 *      (only `/api/conversations/search`), and picking an arbitrary conversation
 *      would make the height number incomparable between runs, which is the one
 *      thing this script exists to produce.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`).
 *
 * Exits non-zero only on a real behavioural failure (hierarchy inverted, thread
 * never mounted, a healthy row still enclosed). Sibling scripts whose CDP shape
 * this follows: `verify-cockpit-shell-scroll.ts`, `verify-conversation-live-tail.ts`.
 */
import { preflightCockpit, skip } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const CONVERSATION_ID = process.env["MINSKY_CONVERSATION_ID"];

/** Desktop viewport — the width the operator actually reads a transcript at. */
const VIEWPORT = { width: 1440, height: 900 };

if (!CONVERSATION_ID) {
  skip("MINSKY_CONVERSATION_ID is not set — see this script's header for why it has no default.");
}

await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

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

// --- In-page measurement -------------------------------------------------

type Measurement = {
  hasThread: boolean;
  /** Rendered height of the whole thread, in CSS px — the SC7 number. */
  threadHeight: number;
  turnCount: number;
  toolRowCount: number;
  proseCount: number;
  /** Tool rows painting a visible (non-zero, non-transparent) border. */
  enclosedToolRows: number;
  /** Tool rows whose name paints in the destructive tone — the expected enclosures. */
  erroredToolRows: number;
  /** Relative luminance 0..1 of the first prose block's text colour. */
  proseLuminance: number;
  /** Relative luminance 0..1 of the first healthy tool row's NAME colour. */
  toolNameLuminance: number;
  proseColor: string;
  toolNameColor: string;
};

/**
 * Measure the painted result.
 *
 * Luminance rather than a raw colour-string compare: the tokens resolve to
 * theme-dependent values, so asserting a literal `rgb(...)` would pin this
 * script to one theme and break on any palette change. Brightness ORDERING is
 * the actual invariant — prose reads louder than machinery — and it holds in
 * light and dark alike as long as the comparison is against the same
 * background, which it is (both sit on the thread's surface).
 */
const MEASURE = `(() => {
  const thread = document.querySelector('[data-testid="conversation-thread"]');
  if (!thread) return JSON.stringify({ hasThread: false });

  const lum = (css) => {
    const m = String(css).match(/-?[\\d.]+/g);
    if (!m || m.length < 3) return -1;
    const [r, g, b] = m.slice(0, 3).map(Number);
    // Rec. 709 luma, normalised. Alpha is deliberately ignored: both samples
    // sit on the same background, so it shifts them together.
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };

  const toolRows = Array.from(thread.querySelectorAll('[data-tool-use-id]'));
  const proseEls = Array.from(thread.querySelectorAll('div.break-words'));

  let enclosed = 0;
  let errored = 0;
  let firstHealthyName = null;
  for (const row of toolRows) {
    const cs = getComputedStyle(row);
    const w = parseFloat(cs.borderTopWidth) || 0;
    const transparent = /rgba\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)/.test(cs.borderTopColor);
    if (w > 0 && !transparent) enclosed++;
    // An errored row is the one whose expanded body is present by default.
    const isError = row.querySelector('button[aria-expanded="true"]') !== null;
    if (isError) errored++;
    else if (!firstHealthyName) firstHealthyName = row.querySelector('span[title]');
  }

  const proseColor = proseEls[0] ? getComputedStyle(proseEls[0]).color : "";
  const toolNameColor = firstHealthyName ? getComputedStyle(firstHealthyName).color : "";

  return JSON.stringify({
    hasThread: true,
    threadHeight: Math.round(thread.getBoundingClientRect().height),
    turnCount: thread.querySelectorAll('[data-turn-index]').length,
    toolRowCount: toolRows.length,
    proseCount: proseEls.length,
    enclosedToolRows: enclosed,
    erroredToolRows: errored,
    proseLuminance: lum(proseColor),
    toolNameLuminance: lum(toolNameColor),
    proseColor,
    toolNameColor,
  });
})()`;

/**
 * Block until the thread has mounted AND stopped growing.
 *
 * The view windows/paginates, so a height read taken the instant the thread
 * appears samples a partial render — a number that never described a settled
 * page. Two consecutive agreeing samples make the wait a function of the
 * observed page rather than of a hardcoded delay.
 */
async function measureWhenStable(ws: WebSocket): Promise<Measurement> {
  const DEADLINE_MS = 30_000;
  const INTERVAL_MS = 250;
  const started = Date.now();
  let previousHeight: number | null = null;
  let last: Measurement | null = null;

  while (Date.now() - started < DEADLINE_MS) {
    const m = JSON.parse(await evaluate(ws, MEASURE)) as Measurement;
    if (m.hasThread) {
      if (previousHeight !== null && previousHeight === m.threadHeight) return m;
      previousHeight = m.threadHeight;
      last = m;
    }
    await sleep(INTERVAL_MS);
  }
  if (last) throw new Error(`thread never settled; last height ${last.threadHeight}px`);
  throw new Error("conversation thread never mounted");
}

// --- Run -----------------------------------------------------------------

const teardown: Array<() => unknown> = [];
let failures = 0;
const fail = (msg: string) => {
  console.error(`FAIL: ${msg}`);
  failures++;
};

let ws: WebSocket | undefined;
try {
  const url = `${COCKPIT}/conversation/${CONVERSATION_ID}`;
  const newRes = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const target = (await newRes.json()) as { id: string; webSocketDebuggerUrl: string };
  teardown.push(() => fetch(`${CDP}/json/close/${target.id}`));

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  ws = socket;
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP websocket failed")), {
      once: true,
    });
  });

  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const m = await measureWhenStable(ws);

  console.log(JSON.stringify({ conversation: CONVERSATION_ID, viewport: VIEWPORT, ...m }, null, 2));

  // 1. Something was actually measured. A thread with no tool rows exercises
  //    nothing this script asserts, so it is a failure of the RUN, not a pass.
  if (m.toolRowCount === 0) {
    fail(
      "conversation has no tool calls — pick a tool-dense conversation, this run proves nothing"
    );
  }
  if (m.proseCount === 0) {
    fail("conversation has no prose blocks — the hierarchy comparison has no left-hand side");
  }

  // 2. The hierarchy itself: prose paints brighter than machinery.
  if (m.proseLuminance >= 0 && m.toolNameLuminance >= 0) {
    if (m.proseLuminance <= m.toolNameLuminance) {
      fail(
        `prose does not outweigh machinery: prose ${m.proseColor} (luma ${m.proseLuminance.toFixed(3)}) ` +
          `is not brighter than tool name ${m.toolNameColor} (luma ${m.toolNameLuminance.toFixed(3)})`
      );
    }
  } else if (m.toolRowCount > 0 && m.proseCount > 0) {
    fail("could not sample both colours — check the selectors against the current markup");
  }

  // 3. Enclosure is reserved for failures.
  if (m.enclosedToolRows > m.erroredToolRows) {
    fail(
      `${m.enclosedToolRows} tool rows paint a border but only ${m.erroredToolRows} errored — ` +
        `a healthy call must be a bare line`
    );
  }

  if (failures === 0) {
    console.log(
      `PASS: ${m.turnCount} turns / ${m.toolRowCount} tool rows / ${m.proseCount} prose blocks ` +
        `render in ${m.threadHeight}px; prose luma ${m.proseLuminance.toFixed(3)} > ` +
        `tool-name luma ${m.toolNameLuminance.toFixed(3)}; ${m.enclosedToolRows} enclosed rows ` +
        `(${m.erroredToolRows} errored).`
    );
  }
} finally {
  ws?.close();
  for (const t of teardown) {
    try {
      await t();
    } catch {
      // Teardown is best-effort: a tab that already closed (or a chromium that
      // exited) must not mask the measurement's own verdict.
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
