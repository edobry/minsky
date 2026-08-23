#!/usr/bin/env bun
/**
 * Conversation-thread orientation, verified in a real browser (mt#3688).
 *
 * Exercises what a zero-height test DOM cannot. The component suite runs under
 * happy-dom, where `scrollTop` / `scrollHeight` / `clientHeight` all read 0
 * (measured mt#3338) — so `isNearTop` is structurally incapable of firing there,
 * and "the reader's position did not move across a reveal" is not a statement
 * that can even be made. Both are the substance of mt#3688, so both are checked
 * here against a real scrollport with real layout.
 *
 * Assertions:
 *   1. A long conversation starts windowed: the start boundary reports hidden
 *      turns, the beginning marker is absent, and the position readout's
 *      denominator is the WHOLE transcript.
 *   2. Scrolling near the top reveals older turns with NO click.
 *   3. The reveal holds the reader's position: the scroll offset moves by
 *      exactly the height that was prepended above them.
 *   4. `overflow-anchor` computes to `none` on the thread — the browser's own
 *      scroll anchoring is off, so assertion 3 measured this code's correction
 *      and not the engine's. This matters because the correction has to carry
 *      the whole load in WebKit, where per MDN scroll anchoring does not exist
 *      and where the tray's macOS window actually renders. Without this check a
 *      Chromium run could pass on the engine's behavior while the tray jumped.
 *   5. Repeated reveals reach the beginning, and the beginning is NAMED (the
 *      marker appears, the hidden-turn boundary goes away).
 *
 * Usage:
 *   bun scripts/verify-conversation-orientation.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3839 bun scripts/verify-conversation-orientation.ts
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
 *      launches (`src/cockpit/dev-chromium.ts`).
 *
 *   3. A cockpit auth token at `~/.local/state/minsky/cockpit-token`, written by
 *      the cockpit daemon on first start. No manual step.
 *
 *   4. Some ingested conversation with more than {@link MIN_TURNS} turns. One is
 *      discovered from the agents widget; `MINSKY_CONVERSATION_ID` overrides.
 *
 * Unlike its sibling `verify-conversation-live-tail.ts`, this spawns no agent
 * and costs no tokens — it only READS an already-ingested transcript.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`),
 * `MINSKY_CONVERSATION_ID` (default: discovered).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { preflightCockpit, skip } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const TOKEN_PATH = join(homedir(), ".local/state/minsky/cockpit-token");

/**
 * How long a transcript has to be to exercise the mechanism.
 *
 * INITIAL_TURNS (50) render on mount and OLDER_CHUNK (100) is one reveal, so
 * 150 is the smallest transcript where a reveal happens AND leaves the thread
 * still windowed — which is what makes assertion 3 measurable at all. Below it
 * the single reveal lands at the beginning and there is no held position to
 * check. Not a round number: it is INITIAL_TURNS + OLDER_CHUNK.
 */
const MIN_TURNS = 150;

/**
 * Px of slack allowed when comparing the held scroll position.
 *
 * One line of body text in this thread (`text-sm` at `leading-relaxed`, ~24px).
 * The compensation is exact by construction — it adds back precisely the height
 * the reveal added — so any residual is some OTHER element settling above the
 * reader in the same frame, which no bookkeeping can fully exclude on a live
 * page. Below one line of text there is nothing for a reader to notice, and a
 * tighter bound would fail on content reflow rather than on the behavior under
 * test. Observed residual across runs after the re-baseline in
 * `useThreadWindow`: 0–1px.
 */
const HOLD_TOLERANCE_PX = 24;

let token: string;
try {
  token = readFileSync(TOKEN_PATH, "utf-8").trim();
} catch {
  skip(`no cockpit token at ${TOKEN_PATH}`);
}

/**
 * ABSENT, SLOW and WRONG-SERVICE are three different answers (mt#4149), and the
 * shared preflight keeps them apart: a missing cockpit is a `SKIP:` + exit 0, a
 * present-but-over-budget one exits non-zero rather than printing the same line,
 * and `/api/health`'s `service` field is now asserted rather than a bare 200 —
 * this script reached the right path but never checked which service answered.
 */
await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

const authHeaders = {
  "Content-Type": "application/json",
  Cookie: `minsky_cockpit=${token}`,
  Authorization: `Bearer ${token}`,
};

/** Find an ingested conversation long enough to window. */
async function findLongConversation(): Promise<{ id: string; blocks: number } | null> {
  const fromEnv = process.env["MINSKY_CONVERSATION_ID"];
  const candidates: string[] = [];
  if (fromEnv) candidates.push(fromEnv);
  else {
    const res = await fetch(`${COCKPIT}/api/widget/agents/data`, { headers: authHeaders });
    const body = (await res.json()) as {
      payload?: { agents?: Array<{ conversationId?: string | null }> };
    };
    for (const agent of body.payload?.agents ?? []) {
      if (agent.conversationId) candidates.push(agent.conversationId);
    }
  }

  for (const id of candidates.slice(0, 40)) {
    const res = await fetch(
      `${COCKPIT}/api/cockpit/context-inspector/snapshot?sessionId=${encodeURIComponent(id)}`,
      { headers: authHeaders }
    );
    if (!res.ok) continue;
    const snap = (await res.json()) as { blocks?: unknown[] };
    const blocks = snap.blocks?.length ?? 0;
    if (blocks > MIN_TURNS) return { id, blocks };
  }
  return null;
}

const found = await findLongConversation();
if (!found) skip(`no ingested conversation with more than ${MIN_TURNS} turns`);
console.log(`conversation ${found.id} (${found.blocks} blocks)`);

/** The subset of a CDP `Runtime.evaluate` reply this script reads. */
type CdpResult = { result?: { value?: string }; exceptionDetails?: unknown };

/** One sample of the thread's orientation state, as read in-page by {@link READ}. */
type ThreadState = {
  usedDocumentFallback: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /**
   * Turns still hidden above, parsed out of the start boundary. `0` when the
   * boundary is absent — which is BOTH "at the beginning" and "mid-reveal", so
   * read it alongside {@link ThreadState.revealing} and
   * {@link ThreadState.atStart} rather than alone.
   */
  hiddenBefore: number;
  /** Whether the reveal-in-progress indicator is rendered. */
  revealing: boolean;
  /** Whether the beginning-of-conversation marker is rendered. */
  atStart: boolean;
  /** The position readout's text, e.g. `~340 / 512`. */
  position: string | null;
  /** The readout's denominator — the whole transcript's turn count. */
  total: number;
  overflowAnchor: string;
};

let msgId = 0;
function cdp(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {}
): Promise<CdpResult> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    // Latch so a late timer cannot reject a promise that already settled — the
    // same per-call-timer discipline verify-conversation-live-tail.ts documents.
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
 * Resolve the scrollport the component itself resolved — same rule as `findScrollParent`.
 *
 * Anchored on the thread's own testid, the app-owned handle added for exactly
 * this purpose (PR #2693 R1). It used to reach the thread through the
 * `scroll-mb-8` sentinel's `parentElement` — the same element, but named by a
 * CLASS FRAGMENT that breaks silently on any unrelated markup change, leaving a
 * geometry check to fall back to a non-scrolling `document.scrollingElement`
 * and report a measurement rather than a failure. mt#3843 brought the sibling
 * scripts onto the testid so all of them resolve the same element the same way.
 */
const RESOLVE_PORT = `
  const thread = document.querySelector('[data-testid="conversation-thread"]');
  let port = thread;
  while (port) {
    const s = getComputedStyle(port);
    const scrolls = ["auto","scroll","overlay"].includes(s.overflowY) || ["auto","scroll","overlay"].includes(s.overflow);
    if (scrolls && port.scrollHeight > port.clientHeight) break;
    port = port.parentElement;
  }
  const el = port || document.scrollingElement;`;

const READ = `(() => {${RESOLVE_PORT}
  const boundary = document.querySelector('[data-testid="thread-hidden-above"]');
  const hidden = boundary ? Number((boundary.textContent.match(/(\\d+) earlier/) || [])[1] || 0) : 0;
  const readout = document.querySelector('[data-testid="thread-position-readout"]');
  return JSON.stringify({
    usedDocumentFallback: !port,
    scrollTop: Math.round(el.scrollTop),
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    hiddenBefore: hidden,
    revealing: !!document.querySelector('[data-testid="thread-revealing"]'),
    atStart: !!document.querySelector('[data-testid="thread-start"]'),
    position: readout ? readout.textContent.trim() : null,
    total: readout ? Number((readout.textContent.split("/")[1] || "").trim()) || 0 : 0,
    overflowAnchor: thread ? getComputedStyle(thread).overflowAnchor : "no-thread",
  });
})()`;

/** Scroll to `top` px and fire the listener, as a real scroll would. */
const scrollTo = (top: number) => `(() => {${RESOLVE_PORT}
  el.scrollTop = ${top};
  el.dispatchEvent(new Event("scroll"));
  return "ok";
})()`;

async function readState(ws: WebSocket): Promise<ThreadState> {
  return JSON.parse(await evaluate(ws, READ)) as ThreadState;
}

const url = `${COCKPIT}/conversation/${found.id}`;
const teardown: Array<() => Promise<unknown>> = [];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

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
const results: Record<string, unknown> = {
  cockpit: COCKPIT,
  conversationId: found.id,
  blocks: found.blocks,
};

try {
  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Wait for the thread to mount and land on its newest turn.
  let initial: ThreadState | null = null;
  for (let i = 0; i < 60; i++) {
    initial = await readState(ws);
    if (initial.scrollHeight > initial.clientHeight && initial.position) break;
    await sleep(1000);
  }
  results["initial"] = initial;
  console.log(`\ninitial: ${JSON.stringify(initial)}`);

  if (!initial || initial.scrollHeight <= initial.clientHeight) {
    failures.push(
      "the thread never overflowed its scrollport — nothing to scroll, nothing to check"
    );
  }
  if (initial?.usedDocumentFallback) {
    console.log("note: scrollport resolved to the document fallback");
  }

  // ── 1. A long conversation starts windowed, and says so ──────────────────
  if (initial && initial.hiddenBefore <= 0) {
    failures.push(
      `expected turns hidden above on a ${found.blocks}-block transcript, got hiddenBefore=${initial.hiddenBefore}`
    );
  }
  if (initial?.atStart) {
    failures.push("the beginning marker rendered while turns were still hidden above");
  }
  // The denominator must be the WHOLE transcript. A readout derived from the
  // rendered window alone would report ~50 and tell the operator they are at the
  // end of a conversation they have barely opened.
  const denominator = Number((initial?.position ?? "").split("/")[1]?.trim() ?? 0);
  results["denominator"] = denominator;
  if (!(denominator > MIN_TURNS)) {
    failures.push(
      `position readout denominator ${denominator} is not the whole transcript (${found.blocks} blocks): ${initial?.position}`
    );
  }

  // ── 4. Scroll anchoring is OFF ───────────────────────────────────────────
  // Checked BEFORE the reveal, because it is what makes the reveal's result
  // meaningful: with anchoring on, Chromium would hold the position by itself
  // and assertion 3 would pass here while the tray's WebKit jumped.
  results["overflowAnchor"] = initial?.overflowAnchor;
  if (initial?.overflowAnchor !== "none") {
    failures.push(
      `thread overflow-anchor is "${initial?.overflowAnchor}", not "none" — a held position ` +
        `would be the engine's doing, and WebKit (the tray) has no such engine behavior`
    );
  }

  // ── 2 + 3. Scrolling near the top reveals, and holds position ────────────
  const beforeHidden = initial?.hiddenBefore ?? 0;
  // Park within one viewport of the top, which is the runway `isNearTop` uses.
  await evaluate(ws, scrollTo(Math.max(0, Math.floor((initial?.clientHeight ?? 800) / 2))));
  const parked = await readState(ws);
  results["parked"] = parked;

  let revealed: ThreadState = parked;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    revealed = await readState(ws);
    // Wait for the reveal to SETTLE. Mid-transition the boundary shows the
    // spinner instead of the count, which parses as `hiddenBefore: 0` — a
    // sample taken there would compare the held position against a thread whose
    // new turns are not mounted yet.
    if (!revealed.revealing && (revealed.hiddenBefore < beforeHidden || revealed.atStart)) break;
  }
  results["revealed"] = revealed;
  console.log(`parked:   ${JSON.stringify(parked)}`);
  console.log(`revealed: ${JSON.stringify(revealed)}`);

  if (!revealed.atStart && revealed.hiddenBefore >= beforeHidden) {
    failures.push(
      `scrolling near the top did not reveal older turns without a click: ` +
        `hiddenBefore stayed at ${revealed.hiddenBefore}`
    );
  } else {
    // The prepended content pushed everything down by exactly this much, so a
    // held position means the scroll offset moved by exactly the same amount.
    const grew = revealed.scrollHeight - parked.scrollHeight;
    const moved = revealed.scrollTop - parked.scrollTop;
    results["prependedPx"] = grew;
    results["scrollDeltaPx"] = moved;
    console.log(`prepended ${grew}px, scroll moved ${moved}px`);
    if (grew <= 0) {
      failures.push("the reveal added no height — the hold could not have been exercised");
    } else if (revealed.total !== parked.total) {
      // The transcript gained turns mid-run — a LIVE conversation. This
      // comparison then measures two different things: the script's `grew`
      // includes the turns that landed at the tail, while the view's correction
      // deliberately does not, so a mismatch here says nothing about the hold.
      // Reported rather than failed, and rather than silently passed.
      results["skippedHoldCheck"] = `transcript grew ${parked.total} -> ${revealed.total} mid-run`;
      console.log(
        `note: hold check skipped — the transcript grew ${parked.total} -> ${revealed.total} ` +
          `during the run, which confounds the comparison. Re-run against an idle conversation.`
      );
    } else if (Math.abs(grew - moved) > HOLD_TOLERANCE_PX) {
      failures.push(
        `the reveal MOVED the reader: ${grew}px was prepended but the scroll offset moved ${moved}px ` +
          `(> ${HOLD_TOLERANCE_PX}px apart)`
      );
    }
  }

  // ── 5. Repeated reveals reach a NAMED beginning ──────────────────────────
  let atStart = revealed;
  for (let i = 0; i < 40 && !atStart.atStart; i++) {
    await evaluate(ws, scrollTo(0));
    await sleep(400);
    atStart = await readState(ws);
  }
  results["atStart"] = atStart;
  console.log(`at start: ${JSON.stringify(atStart)}`);
  if (!atStart.atStart) {
    failures.push(
      `scrolling to the top repeatedly never reached the beginning (hiddenBefore=${atStart.hiddenBefore})`
    );
  }
  if (atStart.atStart && atStart.hiddenBefore > 0) {
    failures.push("the beginning marker and the hidden-turns boundary rendered at the same time");
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
  "\nPASS: the thread windowed, revealed on scroll with no click, held the reader's position " +
    "across the reveal with scroll anchoring off, and named its beginning."
);
