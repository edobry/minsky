#!/usr/bin/env bun
/**
 * The thread's bottom-edge controls stack rather than overlap (mt#3843).
 *
 * Exercises what a zero-height test DOM cannot. Three controls pin to the
 * bottom of the conversation scrollport — the return-to-newest button, the
 * position pill, and the host's activity strip. Until mt#3843 each pinned
 * itself, all at `z-10` in one stacking context, so paint order was DOM order:
 * the strip (last, opaque, full-width) covered 16.5px of the pill's 25px and
 * took the click aimed at the pill's "↑ start" button.
 *
 * The component suite CANNOT catch that. It runs under happy-dom, which has no
 * layout engine: `getBoundingClientRect()` returns all-zero and
 * `elementFromPoint` cannot discriminate, so a rect assertion written there
 * passes whether or not the bug exists (`src/cockpit/CLAUDE.md` §Asserting
 * layout geometry). `ConversationView.thread-footer.test.tsx` asserts the
 * STRUCTURE that makes the stacking correct; this asserts the RESULT.
 *
 * Assertions:
 *   1. The position pill's rect does not intersect the activity strip's rect.
 *   2. `elementFromPoint` at the centre of the pill's "↑ start" button resolves
 *      to that button — it is clickable, not merely visible.
 *   3. The strip still reaches the scrollport's bottom edge (its opaque
 *      background is what keeps transcript text from showing beneath it).
 *   4. Where the return-to-newest button is also rendered, its rect intersects
 *      neither of the other two.
 *
 * Usage:
 *   bun scripts/verify-conversation-footer-stack.ts
 *   bun scripts/verify-conversation-footer-stack.ts <conversationId>
 *
 * With no argument it discovers a conversation the cockpit currently reports as
 * LIVE or STALLED — the two presence values under which the activity strip
 * renders at all (`describeActivity`, `web/lib/conversation-presence-display.ts`).
 * That state is transient by nature, so a run with no such conversation exits 0
 * with a `SKIP:` line rather than failing.
 *
 * Prerequisites (each is CHECKED at startup; a missing one SKIPs with exit 0,
 * while one that is PRESENT but too slow to answer is a DIFFERENT outcome —
 * `INCOMPLETE:` and exit 2, never a silent 0, per mt#4149):
 *
 *   1. A running cockpit serving the build under test, started WITHOUT
 *      `--no-dev-chromium` (that flag disables the browser this attaches to):
 *
 *        bun run cockpit:build
 *        bun src/cli.ts cockpit start --port=3839
 *
 *      To verify a change that is not yet on `main`, run both from the SESSION
 *      workspace and point `MINSKY_COCKPIT_URL` at that port — a cockpit
 *      started from `main` serves `main`'s build, not yours.
 *
 *   2. A CDP endpoint at `127.0.0.1:9222` — the shared dev chromium the cockpit
 *      launches (`src/cockpit/dev-chromium.ts`). Check with
 *      `curl -s localhost:9222/json/version`.
 *
 *   3. A cockpit auth token at `~/.local/state/minsky/cockpit-token`, written by
 *      the cockpit daemon on first start. No manual step.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`).
 *
 * Mutates nothing and costs nothing: it observes a conversation that is already
 * running, rather than spawning one the way
 * `scripts/verify-conversation-live-tail.ts` must. Exits non-zero only on a real
 * geometric failure. See also `scripts/README.md`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { preflightCockpit, skip } from "./lib/verify-preflight";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";
const TOKEN_PATH = join(homedir(), ".local/state/minsky/cockpit-token");

/**
 * How far up from the end to park the reader.
 *
 * The overlap exists only in the sticky state: at the very bottom every control
 * is in normal flow and they stack correctly even under the old arrangement, so
 * a check run there would pass against the bug. 600px is comfortably more than
 * the footer's own height, so "scrolled up" is unambiguous.
 */
const SCROLL_UP_PX = 600;

/** Rects closer than this are treated as touching, not overlapping. */
const OVERLAP_EPSILON_PX = 0.5;

/** How far the strip's bottom may sit above the scrollport's before it is a gap. */
const BOTTOM_GAP_TOLERANCE_PX = 1.5;

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

/**
 * Find a conversation whose activity strip will actually render.
 *
 * The predicate mirrors `describeActivity`: the strip appears under LIVE or
 * STALLED and nothing else. Without it there is no second element to collide
 * with and this check has nothing to say.
 */
async function discoverLiveConversation(): Promise<string | null> {
  const res = await fetch(`${COCKPIT}/api/widget/agents/data`, { headers: authHeaders });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    payload?: { agents?: Array<{ conversationId?: string | null }> };
  };
  const ids = [
    ...new Set(
      (body.payload?.agents ?? []).map((a) => a.conversationId).filter((id): id is string => !!id)
    ),
  ];

  for (const id of ids) {
    const pres = await fetch(`${COCKPIT}/api/conversation/${encodeURIComponent(id)}/presence`, {
      headers: authHeaders,
    });
    if (!pres.ok) continue;
    const p = (await pres.json()) as { presence?: string };
    if (p.presence === "LIVE" || p.presence === "STALLED") return id;
  }
  return null;
}

const conversationId = process.argv[2] ?? (await discoverLiveConversation());
if (!conversationId) {
  skip(
    "no conversation is currently LIVE or STALLED — the activity strip only renders in those " +
      "states, so there is nothing to check for overlap. Re-run while an agent is working, or " +
      "pass a conversation id explicitly."
  );
}

// ── CDP plumbing ───────────────────────────────────────────────────────────────

type CdpResult = { result?: { value?: string }; exceptionDetails?: unknown };

let msgId = 0;
function cdp(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {}
): Promise<CdpResult> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    // Latch so a late timer cannot reject a promise that already settled.
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
 * Resolve the scrollport the thread actually scrolls, the same way
 * `findScrollParent` does, so "reaches the bottom edge" is measured against the
 * right box rather than the window.
 *
 * Anchored on `conversation-thread` — the app-owned marker added for exactly
 * this purpose (PR #2693 R1) — and deliberately NOT on `thread-footer`. Keying
 * it on the footer made this script unable to fail: on a build without the fix
 * the footer does not exist, so the walk fell through to
 * `document.scrollingElement` (which does not scroll on this page), the
 * scroll-up below silently no-opped, and the measurement was taken at the
 * bottom of the thread — the one position where every control is in normal flow
 * and nothing overlaps even WITH the bug. A probe whose anchor is the fix
 * reports success on the broken build.
 */
const RESOLVE_PORT = `
  let port = document.querySelector('[data-testid="conversation-thread"]');
  while (port) {
    const s = getComputedStyle(port);
    const scrolls = ["auto","scroll","overlay"].includes(s.overflowY)
      || ["auto","scroll","overlay"].includes(s.overflow);
    if (scrolls && port.scrollHeight > port.clientHeight) break;
    port = port.parentElement;
  }
  const el = port || document.scrollingElement;`;

/** Rect + hit-test readout for the three bottom-edge controls. */
const MEASURE = `
  (() => {
    ${RESOLVE_PORT}
    const q = (s) => document.querySelector(s);
    const rect = (n) => {
      if (!n) return null;
      const b = n.getBoundingClientRect();
      return {
        top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1),
        left: +b.left.toFixed(1), right: +b.right.toFixed(1),
        height: +b.height.toFixed(1),
      };
    };
    const intersects = (a, b) => {
      if (!a || !b) return null;
      const v = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      const h = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      return {
        vertical: +Math.max(0, v).toFixed(1),
        horizontal: +Math.max(0, h).toFixed(1),
        overlapping: v > ${OVERLAP_EPSILON_PX} && h > ${OVERLAP_EPSILON_PX},
      };
    };

    const pill = q('[data-testid="thread-position"]');
    const strip = q('[data-testid="conversation-presence-activity"]');
    const jump = q('[data-testid="jump-to-newest"]');
    const portRect = rect(el);

    const startBtn = pill ? pill.querySelector('button[aria-label*="beginning"]') : null;
    let startHit = null;
    if (startBtn) {
      const b = startBtn.getBoundingClientRect();
      const hit = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2);
      startHit = {
        reachesButton: !!(hit && (hit === startBtn || startBtn.contains(hit))),
        actual: hit
          ? ((hit.closest('[data-testid]') && hit.closest('[data-testid]').dataset.testid) || hit.tagName)
          : null,
      };
    }

    // EVERY button in the footer, not just "↑ start". The footer is
    // pointer-events-none with each member opting back in, so a member added
    // later without that opt-in would be silently unclickable — invisible to a
    // check that only ever probes one known button.
    const footerEl = q('[data-testid="thread-footer"]');
    const buttonHits = footerEl
      ? Array.from(footerEl.querySelectorAll("button")).map((btn) => {
          const b = btn.getBoundingClientRect();
          const hit = b.width > 0 && b.height > 0
            ? document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)
            : null;
          return {
            label: (btn.getAttribute("aria-label") || btn.textContent || "").trim().slice(0, 40),
            rendered: b.width > 0 && b.height > 0,
            reachable: !!(hit && (hit === btn || btn.contains(hit))),
            actual: hit
              ? ((hit.closest('[data-testid]') && hit.closest('[data-testid]').dataset.testid) || hit.tagName)
              : null,
          };
        })
      : [];

    const p = rect(pill), s = rect(strip), j = rect(jump);
    return JSON.stringify({
      present: { pill: !!pill, strip: !!strip, jump: !!jump, footer: !!q('[data-testid="thread-footer"]') },
      stripText: strip ? strip.innerText.slice(0, 60) : null,
      rects: { pill: p, strip: s, jump: j, scrollport: portRect },
      pillVsStrip: intersects(p, s),
      jumpVsPill: intersects(j, p),
      jumpVsStrip: intersects(j, s),
      stripBottomGap: (s && portRect) ? +(portRect.bottom - s.bottom).toFixed(1) : null,
      startHit,
      buttonHits,
    });
  })()`;

const url = `${COCKPIT}/conversation/${encodeURIComponent(conversationId)}`;
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
const results: Record<string, unknown> = { cockpit: COCKPIT, conversationId };

try {
  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // Wait for BOTH controls. The strip depends on a live presence poll, so it can
  // lag the thread's first paint by a poll interval.
  //
  // `threadRendered` is tracked separately so the two outcomes stay separate. A
  // page that never rendered the thread at all is a BROKEN RUN — a bad id, an
  // auth failure, a JS error — and reporting that as "nothing to check" would
  // hide a failure behind a SKIP. Only a page that DID render, but without both
  // controls, is genuinely nothing to check.
  let ready = false;
  let threadRendered = false;
  for (let i = 0; i < 45; i++) {
    const present = JSON.parse(
      await evaluate(
        ws,
        `JSON.stringify({
          thread: !!document.querySelector('[data-testid="conversation-thread"]'),
          pill: !!document.querySelector('[data-testid="thread-position"]'),
          strip: !!document.querySelector('[data-testid="conversation-presence-activity"]'),
        })`
      )
    ) as { thread: boolean; pill: boolean; strip: boolean };
    if (present.thread) threadRendered = true;
    if (present.pill && present.strip) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  if (!ready && !threadRendered) {
    await teardownAll();
    console.error(
      `FAIL: ${url} never rendered a conversation thread within 45s. This is not "nothing to ` +
        "check\" — the page did not load. Check the conversation id, the cockpit's auth, and the " +
        "browser console for that tab."
    );
    process.exit(1);
  }
  if (!ready) {
    await teardownAll();
    skip(
      `conversation ${conversationId} rendered its thread but not both the position pill and the ` +
        "activity strip within 45s — it may have stopped working, or be shorter than the pill's " +
        "turn threshold. Nothing to check."
    );
  }

  // Park the reader above the end — the collision exists only in the sticky state.
  const port = JSON.parse(
    await evaluate(
      ws,
      `(() => {
        ${RESOLVE_PORT}
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - ${SCROLL_UP_PX});
        return JSON.stringify({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      })()`
    )
  ) as { scrollTop: number; scrollHeight: number; clientHeight: number };
  results["scrollport"] = port;

  // The scroll-up must have actually happened. If the scrollport did not
  // resolve, `scrollTop` stays 0 against a non-scrolling element and every
  // measurement below is taken at the BOTTOM of the thread — the one position
  // where the controls sit in normal flow and do not overlap even when the bug
  // is present. Silently measuring there is how this script reported PASS
  // against a build that had the defect; it must fail instead of measuring the
  // wrong thing.
  if (port.scrollHeight <= port.clientHeight) {
    await teardownAll();
    console.error(
      "FAIL: could not resolve a scrolling scrollport for the thread " +
        `(scrollHeight ${port.scrollHeight} <= clientHeight ${port.clientHeight}). ` +
        "Refusing to measure: at the thread's bottom the controls do not overlap even when broken."
    );
    process.exit(1);
  }
  if (port.scrollTop <= 0) {
    await teardownAll();
    console.error(
      "FAIL: the thread did not scroll up (scrollTop 0). The overlap this checks for exists " +
        "only while the reader is scrolled up, so a measurement here proves nothing."
    );
    process.exit(1);
  }
  await sleep(600);

  const m = JSON.parse(await evaluate(ws, MEASURE)) as {
    present: Record<string, boolean>;
    pillVsStrip: { vertical: number; horizontal: number; overlapping: boolean } | null;
    jumpVsPill: { overlapping: boolean } | null;
    jumpVsStrip: { overlapping: boolean } | null;
    stripBottomGap: number | null;
    startHit: { reachesButton: boolean; actual: string | null } | null;
    buttonHits: Array<{
      label: string;
      rendered: boolean;
      reachable: boolean;
      actual: string | null;
    }>;
  };
  results["measured"] = m;

  // 1. The two rects must not intersect.
  if (!m.pillVsStrip) {
    failures.push("could not measure the pill and the strip together");
  } else if (m.pillVsStrip.overlapping) {
    failures.push(
      `the activity strip overlaps the position pill by ${m.pillVsStrip.vertical}px vertically ` +
        `and ${m.pillVsStrip.horizontal}px horizontally — they are sharing the bottom band again`
    );
  }

  // 2. The "↑ start" button must be what is painted at its own centre. Visible
  //    is not the same as reachable, and the reachable half is what broke.
  if (!m.startHit) {
    failures.push("the pill rendered without its jump-to-the-beginning button");
  } else if (!m.startHit.reachesButton) {
    failures.push(
      `a click at the centre of the "↑ start" button lands on ${m.startHit.actual} instead — ` +
        "the control is covered, not merely crowded"
    );
  }

  // 2b. Every OTHER rendered button in the footer must be reachable too. The
  //     footer is `pointer-events-none` with each member opting back in, so a
  //     member added later without that opt-in is silently unclickable — a
  //     check that only probes one known button would never see it.
  for (const b of m.buttonHits.filter((x) => x.rendered && !x.reachable)) {
    failures.push(
      `the footer button "${b.label}" is not clickable — a click at its centre lands on ` +
        `${b.actual}. Footer members must carry \`pointer-events-auto\`; the container is ` +
        "`pointer-events-none` so its transparent regions do not eat clicks meant for the transcript."
    );
  }

  // 3. The strip must still reach the scrollport's bottom edge: its opaque
  //    background is what stops transcript text showing through beneath it, so
  //    a gap is a regression even when nothing overlaps.
  if (m.stripBottomGap === null) {
    failures.push("could not measure the strip against the scrollport");
  } else if (m.stripBottomGap > BOTTOM_GAP_TOLERANCE_PX) {
    failures.push(
      `the activity strip stops ${m.stripBottomGap}px above the scrollport's bottom edge — ` +
        "transcript text will show through the gap"
    );
  }

  // 4. Where the return-to-newest button is also up, it must clear both. It
  //    shared `bottom-2` with the pill and avoided it only by centring.
  if (m.present["jump"]) {
    if (m.jumpVsPill?.overlapping) failures.push("return-to-newest overlaps the position pill");
    if (m.jumpVsStrip?.overlapping) failures.push("return-to-newest overlaps the activity strip");
  } else {
    results["jumpNote"] =
      "return-to-newest was not rendered during this run (it appears only when content arrives " +
      "while the reader is scrolled up), so assertion 4 did not execute";
  }

  // 5. At the BOTTOM of the thread the footer must sit in normal flow, clear of
  //    the newest turn. This is the half mt#3344's `scroll-mb-8` reservation
  //    used to buy: the strip floated BELOW the end sentinel, so aligning the
  //    sentinel to the scrollport's bottom parked the newest turn underneath it.
  //    Moving the footer above the sentinel should make the reservation
  //    unnecessary rather than wrong — this is what checks that it did.
  await evaluate(
    ws,
    `(() => {
      ${RESOLVE_PORT}
      el.scrollTop = el.scrollHeight;
      return "ok";
    })()`
  );
  await sleep(500);
  const atBottom = JSON.parse(
    await evaluate(
      ws,
      `(() => {
        const thread = document.querySelector('[data-testid="conversation-thread"]');
        const footer = document.querySelector('[data-testid="thread-footer"]');
        if (!thread || !footer) return JSON.stringify({ measurable: false });
        // The newest turn is the last thread child before the footer; the
        // footer and the end sentinel are the only nodes after it.
        const kids = Array.from(thread.children);
        const idx = kids.indexOf(footer);
        const newest = idx > 0 ? kids[idx - 1] : null;
        if (!newest) return JSON.stringify({ measurable: false });
        const n = newest.getBoundingClientRect();
        const f = footer.getBoundingClientRect();
        return JSON.stringify({
          measurable: true,
          newestBottom: +n.bottom.toFixed(1),
          footerTop: +f.top.toFixed(1),
          overlap: +Math.max(0, n.bottom - f.top).toFixed(1),
        });
      })()`
    )
  ) as { measurable: boolean; newestBottom?: number; footerTop?: number; overlap?: number };
  results["atBottom"] = atBottom;

  if (atBottom.measurable && (atBottom.overlap ?? 0) > OVERLAP_EPSILON_PX) {
    failures.push(
      `at the bottom of the thread the footer covers the newest turn by ${atBottom.overlap}px ` +
        "— it is floating over content it should be sitting below"
    );
  }
} catch (err) {
  failures.push(`probe error: ${String(err)}`);
} finally {
  await teardownAll();
}

console.log(JSON.stringify(results, null, 2));
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("PASS: the thread's bottom-edge controls stack without overlapping");
