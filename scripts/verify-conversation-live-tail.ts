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
 * Requires a running cockpit whose dev chromium is listening on the CDP port
 * (started WITHOUT `--no-dev-chromium`). Exits 0 with a SKIP when either is
 * absent, so it is safe to run unattended; exits non-zero only on a real
 * behavioral failure.
 *
 * Spawns a real `claude` process via the cockpit's driven-session API and stops
 * it again in the `finally` block.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const TOKEN_PATH = join(homedir(), ".local/state/minsky/cockpit-token");
/** Long enough to stream for a while as ONE turn — the case being verified. */
const PROMPT =
  "Write a numbered list of 40 one-line facts about text rendering. " +
  "One per line, no preamble, no summary.";

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

let token: string;
try {
  token = readFileSync(TOKEN_PATH, "utf-8").trim();
} catch {
  skip(`no cockpit token at ${TOKEN_PATH}`);
}
if (!(await reachable(`${COCKPIT}/health`))) skip(`no cockpit reachable at ${COCKPIT}`);
if (!(await reachable(`${CDP}/json/version`))) skip(`no CDP endpoint at ${CDP}`);

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
    const onMsg = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== id) return;
      ws.removeEventListener("message", onMsg);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 30_000);
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

/** Resolve the scrollport the component itself resolved — same rule as `findScrollParent`. */
const RESOLVE_PORT = `
  const sentinel = document.querySelector('div[aria-hidden][class*="scroll-mb-8"]');
  let port = sentinel ? sentinel.parentElement : null;
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

const url = `${COCKPIT}/driven/${session.sessionId}?compose=${encodeURIComponent(PROMPT)}`;
const newRes = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
const target = (await newRes.json()) as { id: string; webSocketDebuggerUrl: string };
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((res, rej) => {
  ws.addEventListener("open", () => res());
  ws.addEventListener("error", () => rej(new Error("CDP socket failed")));
});

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

  // Wait until the thread genuinely overflows its container.
  let state: ThreadState | null = null;
  for (let i = 0; i < 120; i++) {
    state = await readState(ws);
    if (state.scrollable && state.turns >= 2) break;
    await sleep(1000);
  }
  if (!state?.scrollable) {
    console.error(`FAIL: never became scrollable: ${JSON.stringify(state)}`);
    process.exit(1);
  }
  results["scrollportResolved"] = state.usedDocumentFallback ? "document-fallback" : "container";
  console.log(
    `\nscrollport resolved: ${state.usedDocumentFallback ? "document fallback" : "CONTAINER"}`
  );
  console.log(`geometry: ${JSON.stringify(state)}`);
  if (state.usedDocumentFallback) {
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
    // KNOWN OPEN — mt#3455, reported rather than failed.
    //
    // Staying dismissed requires the reader to be measurable as pinned, and on
    // this page they cannot be: the view scrolls to the SENTINEL while
    // `isPinnedToBottom` measures the SCROLLPORT, and ~86px of chrome sits
    // between the two. So the control comes back on the next delta. That is
    // mt#3376's anchor, deliberately out of scope for mt#3445 (which owns WHEN
    // the control appears), and mt#3455 owns the fix — at which point this
    // becomes a hard assertion again.
    const staleDismiss = jumped.jumpVisible;
    results["clickDismissKnownOpen"] = staleDismiss;
    if (staleDismiss) {
      console.log(
        "KNOWN OPEN (mt#3455): the control re-appeared after being clicked — pinned-ness is " +
          "measured against the scrollport while the scroll targets the sentinel."
      );
    }
  }
} finally {
  ws.close();
  await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
  await fetch(`${COCKPIT}/api/driven-session/${session.sessionId}/stop`, {
    method: "POST",
    headers: authHeaders,
  }).catch(() => {});
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
