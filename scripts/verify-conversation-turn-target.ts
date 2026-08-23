#!/usr/bin/env bun
/**
 * Addressed-turn landing, verified in a real browser (mt#3791).
 *
 * The session film's expanded rows link to a SPECIFIC action. Whether the reader
 * ends up LOOKING at that action is a question about the box model, and the
 * component suite cannot ask it: it runs under happy-dom, where
 * `getBoundingClientRect` and every scroll property read 0 and `scrollIntoView`
 * is a no-op (measured mt#3338). A class-name assertion there would pin the CSS
 * that produced a correct landing and pass unchanged if a new wrapper, a changed
 * breakpoint, or a clipping ancestor broke it — the exact defect class this
 * script exists to catch.
 *
 * Assertions:
 *   1. A `?turn=N` naming a turn OUTSIDE the tail window mounts it — the window
 *      reveals back to it rather than leaving it unmounted, which is the state
 *      the pre-mt#3791 link left the reader in.
 *   2. The addressed turn is IN VIEW: its vertical center lies inside the
 *      scrollport's rect. This is the assertion the whole task is about.
 *   3. It is visibly marked (an addressed-mark ring).
 *   4. NEGATIVE CONTROL, in the real runtime: the same conversation with NO
 *      address does NOT land on that turn — so assertion 2 is measuring the
 *      address and not some accident of where this thread happens to open.
 *   5. A tool-grain `?turn=N&toolUse=ID` marks and lands on that CALL, not
 *      merely the turn containing it (skipped when the transcript has no tool
 *      call outside the tail window).
 *   6. An address naming no rendered turn renders the unresolved note instead of
 *      silently landing somewhere plausible.
 *
 * Usage:
 *   bun scripts/verify-conversation-turn-target.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3839 bun scripts/verify-conversation-turn-target.ts
 *
 * Prerequisites (each is CHECKED at startup — a missing one exits 0 with a
 * `SKIP:` line, so this is safe to run unattended; a prerequisite that is
 * PRESENT but too slow to answer is a DIFFERENT outcome — `INCOMPLETE:` and
 * exit 2, never a silent 0, per mt#4149). Identical to its sibling
 * `verify-conversation-orientation.ts`; see that script's header for the full
 * rationale on each:
 *
 *   1. A cockpit running WITHOUT `--no-dev-chromium`, serving the build you mean
 *      to test (run it from the SESSION workspace to test unmerged work):
 *
 *        bun run cockpit:build
 *        bun src/cli.ts cockpit start --port=3839
 *
 *   2. A CDP endpoint at `127.0.0.1:9222`.
 *   3. A cockpit auth token at `~/.local/state/minsky/cockpit-token`.
 *   4. Some ingested conversation longer than {@link MIN_TURNS} turns.
 *
 * Reads only; spawns no agent and costs no tokens.
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
 * How long a transcript has to be for an address to exercise the reveal.
 *
 * `INITIAL_TURNS` (50) mount on arrival, so a target must sit further back than
 * that for assertion 1 to mean anything. Doubling it leaves room to pick a
 * target comfortably outside the window rather than one turn past its edge —
 * not a round number, it is INITIAL_TURNS * 2.
 */
const MIN_TURNS = 100;

/**
 * Px of slack when asking whether the landing is "in view".
 *
 * One line of body text (`text-sm` / `leading-relaxed`, ~24px). The check is
 * about whether the reader is looking at the turn, and a landing off by less
 * than a line of text is not something a reader can notice. Tighter would fail
 * on content reflow rather than on the behavior under test.
 */
const IN_VIEW_TOLERANCE_PX = 24;

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

/** The block fields this script reads off a context-inspector snapshot. */
type SnapshotBlock = {
  turnIndex?: number;
  rawJsonlType?: string;
  isAbandonedBranch?: boolean;
  content?: unknown;
};

/** A target picked out of a transcript: a turn, and optionally a call inside it. */
type Target = { turnIndex: number; toolUseId?: string };

/** Pull a `tool_use` id out of a block's raw content, when it carries one. */
function toolUseIdOf(block: SnapshotBlock): string | undefined {
  const content = (block.content as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    const p = part as { type?: string; id?: string };
    if (p.type === "tool_use" && typeof p.id === "string") return p.id;
  }
  return undefined;
}

/**
 * Find a long conversation plus two targets inside it.
 *
 * Both targets are taken from the FIRST HALF of the transcript, so each is
 * outside the tail window the thread opens on — a target the thread happens to
 * mount anyway would make assertion 1 vacuous.
 */
async function findTargets(): Promise<{
  id: string;
  blocks: number;
  turn: Target;
  call: Target | null;
} | null> {
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
    const snap = (await res.json()) as { blocks?: SnapshotBlock[] };
    const blocks = snap.blocks ?? [];
    if (blocks.length <= MIN_TURNS) continue;

    // Narrowed to real targets as it is built, so nothing downstream has to
    // assert that a `turnIndex` is present.
    const renderable: Target[] = [];
    for (const block of blocks.slice(0, Math.floor(blocks.length / 2))) {
      if (block.turnIndex === undefined) continue;
      if (block.isAbandonedBranch === true) continue;
      if (block.rawJsonlType !== "user" && block.rawJsonlType !== "assistant") continue;
      const toolUseId = toolUseIdOf(block);
      renderable.push(
        toolUseId === undefined
          ? { turnIndex: block.turnIndex }
          : { turnIndex: block.turnIndex, toolUseId }
      );
    }
    if (renderable.length === 0) continue;

    // Middle of the first half: far enough back to need a reveal, far enough
    // from turn 0 that the landing has room to be centred rather than clamped.
    const turn = renderable[Math.floor(renderable.length / 2)];
    if (!turn) continue;
    return {
      id,
      blocks: blocks.length,
      turn: { turnIndex: turn.turnIndex },
      call: renderable.find((t) => t.toolUseId !== undefined) ?? null,
    };
  }
  return null;
}

const found = await findTargets();
if (!found) skip(`no ingested conversation with more than ${MIN_TURNS} addressable turns`);
console.log(
  `conversation ${found.id} (${found.blocks} blocks) — turn target ${found.turn.turnIndex}${
    found.call
      ? `, call target ${found.call.turnIndex}/${found.call.toolUseId}`
      : ", no call target"
  }`
);

type CdpResult = { result?: { value?: string }; exceptionDetails?: unknown };

/** One reading of where the addressed element ended up, taken in-page. */
type Landing = {
  /** Whether the addressed element is in the DOM at all — assertion 1. */
  mounted: boolean;
  /** Whether its vertical centre is inside the scrollport — assertion 2. */
  inView: boolean;
  /** Whether it carries the addressed-mark ring — assertion 3. */
  marked: boolean;
  /** Which element the address actually resolved to, for diagnosis. */
  resolvedTo: string | null;
  /** Whether the unresolved note is rendered — assertion 6. */
  unresolvedNote: boolean;
  elementCenterY: number | null;
  portTop: number | null;
  portBottom: number | null;
  threadMounted: boolean;
};

let msgId = 0;
function cdp(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {}
): Promise<CdpResult> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    // Latch so a late timer cannot reject an already-settled promise — the
    // per-call-timer discipline the sibling verify scripts document.
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
 * Read the landing for one address.
 *
 * The scrollport is resolved the same way the component resolves it (the
 * `findScrollParent` rule: nearest scrolling ancestor that actually overflows,
 * document as the fallback), so "in view" is measured against the box the reader
 * is actually looking through.
 */
function readLanding(turnIndex: number, toolUseId?: string): string {
  const toolSelector = toolUseId
    ? `turnEl && turnEl.querySelector('[data-tool-use-id=' + JSON.stringify(${JSON.stringify(
        toolUseId
      )}) + ']')`
    : "null";
  return `(() => {
  // Two app-owned handles, in order of how much they promise: the thread's own
  // testid, then the addressed element's ancestry (PR #2693 R1). Neither depends
  // on a class fragment — the sibling scripts' \`scroll-mb-8\` sentinel selector
  // broke silently on any unrelated markup change, and a geometry check that
  // cannot find its scrollport reports "not in view" rather than "could not
  // measure".
  let thread = document.querySelector('[data-testid="conversation-thread"]');
  if (!thread) {
    const anyTurn = document.querySelector('[data-turn-index]');
    thread = anyTurn ? anyTurn.parentElement : null;
  }
  let port = thread;
  while (port) {
    const s = getComputedStyle(port);
    const scrolls = ["auto","scroll","overlay"].includes(s.overflowY) || ["auto","scroll","overlay"].includes(s.overflow);
    if (scrolls && port.scrollHeight > port.clientHeight) break;
    port = port.parentElement;
  }
  const portEl = port || document.scrollingElement;
  const turnEl = document.querySelector('[data-turn-index="${turnIndex}"]');
  const toolEl = ${toolSelector};
  const el = toolEl || turnEl;
  const portRect = portEl === document.scrollingElement
    ? { top: 0, bottom: window.innerHeight }
    : portEl.getBoundingClientRect();
  const rect = el ? el.getBoundingClientRect() : null;
  const centerY = rect ? rect.top + rect.height / 2 : null;
  return JSON.stringify({
    mounted: !!el,
    inView: rect
      ? centerY >= portRect.top - ${IN_VIEW_TOLERANCE_PX} && centerY <= portRect.bottom + ${IN_VIEW_TOLERANCE_PX}
      : false,
    marked: el ? el.className.includes("ring-2") : false,
    resolvedTo: el ? (toolEl ? "call" : "turn") : null,
    unresolvedNote: !!document.querySelector('[data-testid="turn-address-unresolved"]'),
    elementCenterY: centerY === null ? null : Math.round(centerY),
    portTop: Math.round(portRect.top),
    portBottom: Math.round(portRect.bottom),
    threadMounted: !!thread,
  });
})()`;
}

const teardown: Array<() => Promise<unknown>> = [];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

/** Open one URL in its own tab and read the landing once it settles. */
async function landingFor(
  url: string,
  target: Target,
  { expectMounted }: { expectMounted: boolean }
): Promise<Landing> {
  const newRes = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  const tab = (await newRes.json()) as { id: string; webSocketDebuggerUrl: string };
  const closeTab = () => fetch(`${CDP}/json/close/${tab.id}`);
  teardown.push(closeTab);
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  try {
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
    await cdp(ws, "Runtime.enable");
    await cdp(ws, "Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const read = readLanding(target.turnIndex, target.toolUseId);
    let landing = JSON.parse(await evaluate(ws, read)) as Landing;
    for (let i = 0; i < 60; i++) {
      landing = JSON.parse(await evaluate(ws, read)) as Landing;
      // Settle on the thread being mounted AND the expectation resolved either
      // way: an unaddressed control never mounts the target, so waiting for
      // `mounted` there would burn the whole budget on every run.
      if (landing.threadMounted && (landing.mounted === expectMounted || landing.unresolvedNote)) {
        // One more beat for the layout effect's scroll to land.
        await sleep(500);
        landing = JSON.parse(await evaluate(ws, read)) as Landing;
        break;
      }
      await sleep(500);
    }
    return landing;
  } finally {
    ws.close();
    await closeTab().catch(() => {});
  }
}

const failures: string[] = [];
const results: Record<string, unknown> = {
  cockpit: COCKPIT,
  conversationId: found.id,
  blocks: found.blocks,
  turnTarget: found.turn,
  callTarget: found.call,
};

try {
  const base = `${COCKPIT}/conversation/${found.id}`;

  // ── 1 + 2 + 3. An addressed arrival mounts, lands, and is marked ──────────
  const addressed = await landingFor(`${base}?turn=${found.turn.turnIndex}`, found.turn, {
    expectMounted: true,
  });
  results["addressed"] = addressed;
  console.log(`\naddressed: ${JSON.stringify(addressed)}`);

  if (!addressed.threadMounted) {
    failures.push("the conversation thread never mounted — nothing was verified");
  }
  if (!addressed.mounted) {
    failures.push(
      `turn ${found.turn.turnIndex} was never mounted — the window did not reveal back to it ` +
        `(this is the pre-mt#3791 state: the address names a turn that is not in the DOM)`
    );
  } else {
    if (!addressed.inView) {
      failures.push(
        `turn ${found.turn.turnIndex} mounted but is NOT in view: its centre is at ` +
          `${addressed.elementCenterY}px against a scrollport of ` +
          `${addressed.portTop}..${addressed.portBottom}px`
      );
    }
    if (!addressed.marked) {
      failures.push(
        `turn ${found.turn.turnIndex} is not marked — the reader cannot see which turn`
      );
    }
  }
  if (addressed.unresolvedNote) {
    failures.push(
      `the unresolved note rendered for turn ${found.turn.turnIndex}, which the snapshot says exists`
    );
  }

  // ── 4. NEGATIVE CONTROL: no address, no landing ───────────────────────────
  const control = await landingFor(base, found.turn, { expectMounted: false });
  results["control"] = control;
  console.log(`control (no address): ${JSON.stringify(control)}`);
  if (control.marked) {
    failures.push("a turn is marked with NO address in the URL — the mark is not address-driven");
  }
  if (control.mounted && control.inView) {
    failures.push(
      `turn ${found.turn.turnIndex} is already in view with no address, so assertion 2 proves ` +
        `nothing on this conversation — pick a target further from where the thread opens`
    );
  }

  // ── 5. Tool-grain address resolves to the CALL ─────────────────────────────
  const callTarget = found.call;
  if (callTarget?.toolUseId !== undefined) {
    const call = await landingFor(
      `${base}?turn=${callTarget.turnIndex}&toolUse=${encodeURIComponent(callTarget.toolUseId)}`,
      callTarget,
      { expectMounted: true }
    );
    results["call"] = call;
    console.log(`call-grain: ${JSON.stringify(call)}`);
    if (!call.mounted) {
      failures.push(`call ${callTarget.toolUseId} was never mounted`);
    } else {
      if (call.resolvedTo !== "call") {
        failures.push(
          `a tool-grain address resolved to the ${call.resolvedTo}, not the named call — the reader ` +
            `asked for one action out of the turn`
        );
      }
      if (!call.inView) {
        failures.push(
          `call ${callTarget.toolUseId} mounted but is NOT in view: centre ${call.elementCenterY}px ` +
            `against ${call.portTop}..${call.portBottom}px`
        );
      }
      if (!call.marked) failures.push(`call ${callTarget.toolUseId} is not marked`);
    }
  } else {
    results["call"] = "skipped — no tool call outside the tail window";
    console.log("call-grain: SKIPPED (no tool call in the first half of this transcript)");
  }

  // ── 6. An address naming nothing says so ─────────────────────────────────
  const bogus: Target = { turnIndex: found.blocks + 100_000 };
  const unresolved = await landingFor(`${base}?turn=${bogus.turnIndex}`, bogus, {
    expectMounted: false,
  });
  results["unresolved"] = unresolved;
  console.log(`unresolved: ${JSON.stringify(unresolved)}`);
  if (!unresolved.unresolvedNote) {
    failures.push(
      `an address naming turn ${bogus.turnIndex} rendered no note — the reader cannot tell the ` +
        `link failed to land`
    );
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
  "\nPASS: an addressed link revealed its turn, scrolled it into view and marked it; the same " +
    "conversation with no address did neither; a tool-grain address landed on the call; and an " +
    "address naming nothing said so."
);
