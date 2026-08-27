#!/usr/bin/env bun
/**
 * Conversation-switcher pinning, verified in a real browser (mt#3691 AT2).
 *
 * The claim AT2 makes is geometric: with the Conversation tab scrolled deep
 * into a transcript, the switcher is STILL on screen. The component suite runs
 * under happy-dom, which has no layout engine — `getBoundingClientRect()` reads
 * 0 for everything (`src/cockpit/CLAUDE.md` §Asserting layout geometry) — so
 * the strongest thing assertable there is that the switcher is a DESCENDANT of
 * the sticky container. That is a class-name-and-containment surrogate: it
 * cannot catch a regression that leaves both intact and breaks the geometry
 * anyway (an ancestor that starts clipping, a new wrapper, a changed `top`).
 * This script measures the real box model, which is the only way to settle it.
 *
 * ## Why the API is stubbed in-page
 *
 * The switcher renders only for a workspace with 2+ conversation candidates.
 * As of 2026-08-04 NO live workspace has one: of the link rows whose workspace
 * still exists in `sessions`, every single one has exactly one conversation.
 * The 88 multi-conversation workspaces in `minsky_session_links` are historical
 * — their sessions were cleaned up after merge, so `/api/agents/:id` 404s for
 * them. The alternatives were to write a second link row into the shared
 * database purely to make a UI check runnable (a production mutation for a
 * screenshot, and not the agent's call to authorize), or to leave the claim
 * unverified.
 *
 * Stubbing `/api/agents/:id` in the page takes neither option. What is under
 * test here is CSS and layout, not the payload: the browser is real, the bundle
 * is real, the stylesheet is real, the scroll is real. The payload's only job
 * is to put the component into the 2-candidate state that makes the switcher
 * exist. The server half — that the real API actually emits `label` and
 * `linkType` — is verified separately against the live database, and neither
 * check substitutes for the other.
 *
 * ## Assertions
 *
 *   1. The switcher renders at all for a 2-candidate workspace.
 *   2. Its primary text is the LABEL, and it contains no bare uuid.
 *   3. The provenance chip renders the formatted link type ("Session creator").
 *   4. It is inside the viewport BEFORE scrolling (baseline).
 *   5. It is STILL inside the viewport after `<main>` is scrolled to the bottom
 *      of 3000px of injected overflow. This is AT2.
 *   6. CONTROL: a non-sticky probe element that started on screen has moved off
 *      it. Without this, a scroll that silently did nothing would satisfy (5)
 *      trivially — the check would pass on a page that cannot scroll at all,
 *      which is exactly the shape of false PASS worth designing out.
 *
 * Overflow is INJECTED rather than obtained by loading a long transcript, for
 * the reason `verify-cockpit-shell-scroll.ts` gives: the property under test
 * belongs to the chrome, not to any conversation's turn count, and injection
 * makes the check independent of what data happens to exist when it runs.
 *
 * Usage:
 *   bun scripts/verify-conversation-switcher-pinned.ts
 *   MINSKY_COCKPIT_URL=http://127.0.0.1:3861 bun scripts/verify-conversation-switcher-pinned.ts
 *
 * Prerequisites (each CHECKED at startup — a missing one exits 0 with a `SKIP:`
 * line, so running this unattended is safe. A prerequisite that is PRESENT but
 * too slow to answer is a DIFFERENT outcome: `INCOMPLETE:` and exit 2, never a
 * silent 0 — mt#4149):
 *
 *   1. A running cockpit started WITHOUT `--no-dev-chromium` (that flag
 *      disables the very browser this attaches to):
 *
 *        bun run cockpit:build
 *        bun src/cli.ts cockpit start --port=3861
 *
 *      To verify a change not yet on `main`, run BOTH from the SESSION
 *      workspace and point `MINSKY_COCKPIT_URL` at that port — a cockpit
 *      started from `main` serves `main`'s build, not yours.
 *
 *   2. A CDP endpoint at `127.0.0.1:9222`. Check with
 *      `curl -s localhost:9222/json/version`.
 *
 * Overrides: `MINSKY_COCKPIT_URL` (default `http://127.0.0.1:3737`),
 * `MINSKY_CDP_URL` (default `http://127.0.0.1:9222`).
 *
 * Local/operator-run, not CI: CI has neither a cockpit daemon nor a browser.
 * Exits non-zero only on a real behavioral failure. Sibling CDP shape:
 * `scripts/verify-cockpit-shell-scroll.ts` (mt#3338).
 */
import { preflightCockpit } from "./lib/verify-preflight";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const COCKPIT = process.env["MINSKY_COCKPIT_URL"] ?? "http://127.0.0.1:3737";
const CDP = process.env["MINSKY_CDP_URL"] ?? "http://127.0.0.1:9222";

const VIEWPORT = { width: 1280, height: 900 };
const PROBE_HEIGHT_PX = 3000;
const PROBE_ID = "mt3691-overflow-probe";

/** Synthetic ids. Nothing real is read for them — the payload below is stubbed. */
const WORKSPACE_ID = "mt3691-verify-workspace";
const CONV_ORCHESTRATOR = "11111111-2222-3333-4444-555555555555";
const CONV_SUBAGENT = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const LABEL_ORCHESTRATOR = "Conversation switcher legibility";
const LABEL_SUBAGENT = "implementer — mt#3691";

// --- Prerequisites -------------------------------------------------------

/**
 * ABSENT, SLOW and WRONG-SERVICE are three different answers (mt#4149), and the
 * shared preflight keeps them apart: a missing cockpit is a `SKIP:` + exit 0, a
 * present-but-over-budget one exits non-zero rather than printing the same line,
 * and `/api/health`'s `service` field is asserted rather than a bare 200.
 */
await preflightCockpit({ cockpitUrl: COCKPIT, cdpUrl: CDP });

// --- The stubbed payload -------------------------------------------------

const WORKSPACE_PAYLOAD = {
  session: {
    sessionId: WORKSPACE_ID,
    shortId: "ws#3691",
    taskId: "mt#3691",
    taskTitle: "Conversation switcher legibility",
    status: "IN-REVIEW",
    liveness: "healthy",
    agentId: null,
    branch: "task/mt-3691",
    repoName: "edobry/minsky",
    repoUrl: null,
    createdAt: null,
    lastActivityAt: null,
    lastCommitHash: null,
    lastCommitMessage: null,
    commitCount: 0,
  },
  commits: [],
  pr: null,
  conversation: { agentSessionId: CONV_ORCHESTRATOR },
  conversations: [
    {
      agentSessionId: CONV_ORCHESTRATOR,
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      source: "link-row",
      label: LABEL_ORCHESTRATOR,
      linkType: "session_creator",
    },
    {
      agentSessionId: CONV_SUBAGENT,
      startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      source: "link-row",
      label: LABEL_SUBAGENT,
      linkType: "subagent_spawn",
    },
  ],
  driven: null,
};

/**
 * Installed via `Page.addScriptToEvaluateOnNewDocument` so it is in place
 * BEFORE the SPA's first render — a patch applied after boot would race the
 * component's own initial fetch and make the check order-dependent.
 *
 * Only `/api/agents/:id` is intercepted. Everything else (presence, transcript)
 * reaches the real server and 404s for these synthetic ids, which is fine: those
 * surfaces are not under test here and their empty states do not affect the
 * chrome's geometry.
 */
const INSTALL_STUB = `(() => {
  const payload = ${JSON.stringify(JSON.stringify(WORKSPACE_PAYLOAD))};
  const original = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const raw = typeof input === "string" ? input : (input && input.url) || "";
    let pathname = "";
    try { pathname = new URL(raw, location.origin).pathname; } catch { pathname = ""; }
    if (/^\\/api\\/agents\\/[^/]+$/.test(pathname)) {
      return Promise.resolve(
        new Response(payload, { status: 200, headers: { "Content-Type": "application/json" } })
      );
    }
    return original(input, init);
  };
  return "ok";
})()`;

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

const SWITCHER_SELECTOR = '[data-testid="conversation-switcher"]';

/**
 * Install the overflow probe as a SIBLING of the pinned chrome, inside the
 * chrome's own parent — NOT appended to `<main>`.
 *
 * This distinction is the whole check. `position: sticky` is bounded by its
 * containing block: an element sticks only while its PARENT's box is still in
 * view, then leaves with it. Appending 3000px to `<main>` puts the overflow
 * OUTSIDE the chrome's parent, so scrolling past that parent drags the sticky
 * chrome off screen — and the script reports a pinning failure that says
 * nothing about the product. (Measured on the first run of this script:
 * switcher top went to -2209 with the probe on `<main>`.) Real transcript
 * content is a sibling of the chrome inside that same parent, which is what
 * this reproduces: the parent grows, the chrome stays.
 *
 * Returns "no-chrome" when the pinned container never rendered, so the caller
 * can distinguish that from a genuine pinning failure.
 */
const INSTALL_PROBE = `(() => {
  const chrome = document.querySelector('[data-testid="run-detail-chrome"]');
  const host = chrome && chrome.parentElement;
  if (!host) return "no-chrome";
  let probe = document.getElementById(${JSON.stringify(PROBE_ID)});
  if (!probe) {
    probe = document.createElement("div");
    probe.id = ${JSON.stringify(PROBE_ID)};
    host.appendChild(probe);
  }
  probe.style.height = ${JSON.stringify(`${PROBE_HEIGHT_PX}px`)};
  probe.style.flex = "none";
  probe.style.position = "relative";
  probe.textContent = "";
  const head = document.createElement("div");
  head.id = ${JSON.stringify(`${PROBE_ID}-head`)};
  head.textContent = "HEAD";
  head.style.position = "absolute";
  head.style.top = "0";
  probe.appendChild(head);
  return "ok";
})()`;

/**
 * Read everything in one round-trip so the switcher's rect and the control
 * element's rect are sampled from the SAME layout — two separate reads could
 * straddle a scroll or a re-render and describe a state that never existed.
 */
const READ = `(() => {
  const sw = document.querySelector(${JSON.stringify(SWITCHER_SELECTOR)});
  const main = document.querySelector("main");
  const head = document.getElementById(${JSON.stringify(`${PROBE_ID}-head`)});
  const probe = document.getElementById(${JSON.stringify(PROBE_ID)});
  const chrome = document.querySelector('[data-testid="run-detail-chrome"]');
  const host = chrome && chrome.parentElement;
  const r = sw ? sw.getBoundingClientRect() : null;
  const h = head ? head.getBoundingClientRect() : null;
  const hostRect = host ? host.getBoundingClientRect() : null;
  return JSON.stringify({
    hasSwitcher: !!sw,
    text: sw ? sw.textContent : "",
    switcherTop: r ? Math.round(r.top) : null,
    switcherBottom: r ? Math.round(r.bottom) : null,
    headTop: h ? Math.round(h.top) : null,
    // Reported so a pinning failure is diagnosable rather than merely red: a
    // sticky element cannot outlive its containing block, so a hostBottom above
    // the viewport explains the switcher leaving without implicating the CSS.
    hostBottom: hostRect ? Math.round(hostRect.bottom) : null,
    chromePosition: chrome ? getComputedStyle(chrome).position : null,
    hasMain: !!main,
    mainScrollTop: main ? Math.round(main.scrollTop) : null,
    maxScrollTop: main ? Math.round(main.scrollHeight - main.clientHeight) : null,
    probeHeight: probe ? Math.round(probe.getBoundingClientRect().height) : 0,
    innerHeight: window.innerHeight,
  });
})()`;

const SCROLL_TO_BOTTOM = `(() => {
  const main = document.querySelector("main");
  if (!main) return "no-main";
  main.scrollTop = main.scrollHeight;
  return "ok";
})()`;

type PageState = {
  hasSwitcher: boolean;
  text: string;
  switcherTop: number | null;
  switcherBottom: number | null;
  headTop: number | null;
  hostBottom: number | null;
  chromePosition: string | null;
  hasMain: boolean;
  mainScrollTop: number | null;
  maxScrollTop: number | null;
  probeHeight: number;
  innerHeight: number;
};

async function read(ws: WebSocket): Promise<PageState> {
  return JSON.parse(await evaluate(ws, READ)) as PageState;
}

/**
 * Wait for a condition on the page rather than for a duration. A fixed delay
 * long enough on a warm machine is exactly the flake this avoids, and one too
 * short reports "the bundle failed to boot" for a page that was still starting.
 */
async function waitFor(
  ws: WebSocket,
  what: string,
  predicate: (s: PageState) => boolean,
  deadlineMs = 20_000
): Promise<PageState> {
  const started = Date.now();
  let last: PageState | null = null;
  while (Date.now() - started < deadlineMs) {
    last = await read(ws);
    if (predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(
    `timed out after ${deadlineMs}ms waiting for ${what} ` +
      `(last sample: ${last ? JSON.stringify(last) : "none"})`
  );
}

// --- Run -----------------------------------------------------------------

const failures: string[] = [];
const teardown: Array<() => Promise<unknown>> = [];
async function teardownAll(): Promise<void> {
  for (const step of teardown.reverse()) await step().catch(() => {});
}

let ws: WebSocket;
try {
  // Open BLANK, install the stub, then navigate — the stub has to be registered
  // before the document that boots the SPA exists.
  const newRes = await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" });
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

try {
  await cdp(ws, "Page.enable");
  await cdp(ws, "Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp(ws, "Page.addScriptToEvaluateOnNewDocument", { source: INSTALL_STUB });
  await cdp(ws, "Page.navigate", {
    url: `${COCKPIT}/agents/${encodeURIComponent(WORKSPACE_ID)}/conversation`,
  });

  // 1. The switcher exists for a 2-candidate workspace.
  const initial = await waitFor(ws, "the switcher to render", (s) => s.hasSwitcher);
  console.log("PASS: the switcher renders for a 2-candidate workspace");

  // 2/3. It reads as a label plus a formatted link class, not a uuid.
  if (!initial.text.includes(LABEL_ORCHESTRATOR)) {
    failures.push(`switcher text does not contain the label: ${JSON.stringify(initial.text)}`);
  } else {
    console.log(`PASS: primary text is the label (${JSON.stringify(LABEL_ORCHESTRATOR)})`);
  }
  if (initial.text.includes(CONV_ORCHESTRATOR)) {
    failures.push(`switcher text still contains a bare uuid: ${JSON.stringify(initial.text)}`);
  } else {
    console.log("PASS: no bare uuid in the switcher text");
  }
  if (!initial.text.includes("Session creator")) {
    failures.push(`provenance chip missing or unformatted: ${JSON.stringify(initial.text)}`);
  } else {
    console.log('PASS: provenance chip renders as "Session creator"');
  }

  // 4. Baseline: on screen before any scrolling.
  const onScreen = (s: PageState): boolean =>
    s.switcherTop !== null &&
    s.switcherBottom !== null &&
    s.switcherTop >= -1 &&
    s.switcherBottom <= s.innerHeight + 1;

  if (!onScreen(initial)) {
    failures.push(
      `switcher is not on screen before scrolling (top=${initial.switcherTop}, ` +
        `bottom=${initial.switcherBottom}, innerHeight=${initial.innerHeight})`
    );
  } else {
    console.log(`PASS: on screen before scrolling (top=${initial.switcherTop})`);
  }

  // 5/6. Inject overflow, scroll to the bottom, re-measure.
  const installed = await evaluate(ws, INSTALL_PROBE);
  if (installed !== "ok") {
    failures.push(
      installed === "no-chrome"
        ? "the pinned chrome container never rendered — bad route, or the bundle failed to boot"
        : `could not install the overflow probe: ${installed}`
    );
  } else {
    const withProbe = await waitFor(
      ws,
      "the overflow probe to lay out",
      (s) => s.probeHeight >= PROBE_HEIGHT_PX && s.headTop !== null
    );
    const headTopBefore = withProbe.headTop as number;

    await evaluate(ws, SCROLL_TO_BOTTOM);
    const scrolled = await waitFor(
      ws,
      "the scroll to land at the bottom",
      (s) => s.mainScrollTop !== null && s.maxScrollTop !== null && s.mainScrollTop > 0
    );

    // 6. CONTROL FIRST: prove the page actually scrolled. Without this, a
    // scrollTop assignment that did nothing would make assertion 5 pass on a
    // page where nothing can move — a false PASS in the same direction as the
    // defect.
    const headTopAfter = scrolled.headTop as number;
    const moved = headTopBefore - headTopAfter;
    if (moved < 100) {
      failures.push(
        `CONTROL FAILED: the page did not actually scroll (probe head moved ${moved}px; ` +
          `scrollTop=${scrolled.mainScrollTop}/${scrolled.maxScrollTop}). ` +
          `The pinning assertion below would be vacuous, so it is not reported.`
      );
    } else {
      console.log(
        `PASS (control): the page really scrolled — non-sticky probe head moved ${moved}px ` +
          `(scrollTop=${scrolled.mainScrollTop}/${scrolled.maxScrollTop})`
      );

      // 5. AT2 proper.
      if (!onScreen(scrolled)) {
        const diagnosis =
          scrolled.hostBottom !== null && scrolled.hostBottom < 0
            ? `The chrome's containing block scrolled out of view, which a sticky element cannot outlive — check where the probe was installed before blaming the CSS.`
            : `The containing block is still in view, so this is a real pinning failure.`;
        failures.push(
          `AT2 FAILED: switcher left the viewport after scrolling ` +
            `(top=${scrolled.switcherTop}, bottom=${scrolled.switcherBottom}, ` +
            `innerHeight=${scrolled.innerHeight}, chromePosition=${scrolled.chromePosition}, ` +
            `hostBottom=${scrolled.hostBottom}). ${diagnosis}`
        );
      } else {
        console.log(
          `PASS (AT2): switcher still on screen after scrolling to the bottom ` +
            `(top=${scrolled.switcherTop}, bottom=${scrolled.switcherBottom})`
        );
      }
      if (!scrolled.text.includes(LABEL_ORCHESTRATOR)) {
        failures.push("switcher lost its label after scrolling");
      }
    }
  }
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
}

await teardownAll();

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log("OK: conversation switcher is legible and stays pinned while scrolled");
