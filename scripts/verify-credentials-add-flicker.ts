#!/usr/bin/env bun
/**
 * Measure the credentials Add interaction for flicker (mt#5032).
 *
 * This is the instrument that reproduced the defect, kept so the before/after
 * is re-runnable rather than a one-off. It samples the form per animation frame
 * across a real Add click and reports three things the original bug produced:
 *
 *   1. how long the form LOOKS busy (was 83 ms — a flash, not feedback)
 *   2. whether the feedback block is torn down and rebuilt (was: gone ~17 ms,
 *      back as a different DOM node)
 *   3. how far the form's height jumps when a result appears (was 102 → 142 px)
 *
 * ## Safety
 *
 * Drives the form with a token that FAILS every provider's shape/auth check, so
 * `addCredential` returns before persisting. **Nothing is written to the
 * credential store.** Do not "improve" this by passing a well-formed token: a
 * well-formed one is STORED, and this script points at whatever cockpit you
 * give it — including the operator's.
 *
 * ## Usage
 *
 *   bun scripts/verify-credentials-add-flicker.ts
 *   bun scripts/verify-credentials-add-flicker.ts --cockpit http://127.0.0.1:3941 --cdp 9335
 *
 * Requires a cockpit serving the settings page and a Chrome listening on the
 * CDP port. Both are PRECONDITIONS, not things this script provisions — when
 * either is absent it SKIPs with exit 0 rather than failing, so it is safe to
 * wire into a suite that does not always have a browser.
 *
 *   exit 0 = pass, or skipped (precondition absent — the reason is printed)
 *   exit 1 = a measured regression
 *   exit 2 = the probe itself could not complete (never conflated with a pass)
 */

interface Args {
  cockpit: string;
  cdpPort: number;
}

function parseArgs(argv: readonly string[]): Args {
  let cockpit = "http://127.0.0.1:3737";
  let cdpPort = 9335;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cockpit" && argv[i + 1]) cockpit = String(argv[++i]);
    else if (argv[i] === "--cdp" && argv[i + 1]) cdpPort = Number(argv[++i]);
  }
  return { cockpit, cdpPort };
}

/**
 * Thresholds. The busy-affordance one is deliberately tied to the component's
 * own delay rather than restated: if `BUSY_AFFORDANCE_DELAY_MS` moves, a probe
 * carrying a stale copy would keep passing while the behaviour changed.
 */
const MAX_LAYOUT_JUMP_PX = 8;

function skip(reason: string): never {
  console.log(JSON.stringify({ status: "SKIP", reason }, null, 2));
  process.exit(0);
}

async function reachable(url: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

interface Cdp {
  evaluate(expression: string): Promise<unknown>;
  close(): Promise<void>;
}

async function openTab(cdpPort: number, url: string): Promise<Cdp> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${url}`, { method: "PUT" });
  const tab = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  const pending = new Map<number, (v: unknown) => void>();
  let id = 0;
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("CDP websocket failed to open"));
  });
  ws.onmessage = (event: MessageEvent) => {
    const msg = JSON.parse(String(event.data)) as { id?: number };
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const myId = ++id;
    return new Promise((resolve) => {
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  };
  await send("Runtime.enable");
  return {
    async evaluate(expression: string) {
      const raw = (await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { exceptionDetails?: unknown; result?: { value?: unknown } } };
      if (raw.result?.exceptionDetails) {
        throw new Error(
          `in-page error: ${JSON.stringify(raw.result.exceptionDetails).slice(0, 300)}`
        );
      }
      return raw.result?.result?.value;
    },
    async close() {
      await fetch(`http://127.0.0.1:${cdpPort}/json/close/${tab.id}`).catch(() => undefined);
      ws.close();
    },
  };
}

const INSTALL_SAMPLER = `
(() => {
  const input = document.querySelector('#cred-token-input');
  const addBtn = document.querySelector('[aria-label="Validate and save token"]');
  const form = input.closest('.space-y-3');
  const w = window;
  w.__probe = { t0: performance.now(), samples: [], firstBlockNode: null };
  const sample = () => {
    const block = document.querySelector('[role="status"], [role="alert"]');
    if (block && !w.__probe.firstBlockNode) w.__probe.firstBlockNode = block;
    w.__probe.samples.push({
      t: +(performance.now() - w.__probe.t0).toFixed(1),
      opacity: getComputedStyle(input).opacity,
      btn: addBtn.textContent.trim(),
      formH: +form.getBoundingClientRect().height.toFixed(1),
      blocks: document.querySelectorAll('[role="status"], [role="alert"]').length,
      sameBlock: block && w.__probe.firstBlockNode ? block === w.__probe.firstBlockNode : null,
    });
    if (performance.now() - w.__probe.t0 < 5000) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  return true;
})()`;

// A token no provider accepts — see the safety note in the file docblock.
const REFUSED_TOKEN = "not-a-real-token-shape";

const TYPE_TOKEN = `
(() => {
  const input = document.querySelector('#cred-token-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(REFUSED_TOKEN)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input.value.length;
})()`;

/**
 * Press Validate FIRST, and wait for its verdict to render.
 *
 * This is setup, not decoration: the tear-down defect only exists when a
 * feedback block is ALREADY on screen when Add is pressed. Without it the two
 * block-identity checks below can never fire — the first version of this script
 * clicked Add alone and reported `droppedOut: false` / `replaced: false`
 * against a build that provably had the defect. A check that cannot fail is not
 * a check.
 */
const CLICK_VALIDATE = `
(() => {
  document.querySelector('[aria-label="Validate token without saving"]').click();
  return true;
})()`;

const CLICK_ADD = `
(() => {
  window.__probe.clickAt = +(performance.now() - window.__probe.t0).toFixed(1);
  document.querySelector('[aria-label="Validate and save token"]').click();
  return window.__probe.clickAt;
})()`;

async function main(): Promise<void> {
  const { cockpit, cdpPort } = parseArgs(process.argv.slice(2));

  if (!(await reachable(`${cockpit}/api/health`))) {
    skip(`no cockpit answering at ${cockpit}/api/health — start one and re-run`);
  }
  if (!(await reachable(`http://127.0.0.1:${cdpPort}/json/version`))) {
    skip(`no Chrome on CDP port ${cdpPort} — launch one with --remote-debugging-port=${cdpPort}`);
  }

  const tab = await openTab(cdpPort, `${cockpit}/settings`);
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      const found = await tab
        .evaluate(`!!document.querySelector('#cred-token-input')`)
        .catch(() => false);
      if (found === true) {
        ready = true;
        break;
      }
      await Bun.sleep(500);
    }
    // Fail LOUDLY rather than measuring an unrendered page: every assertion
    // below would otherwise read as a clean pass over nothing.
    if (!ready) {
      console.error("the settings page never rendered the Add form — nothing measured");
      process.exit(2);
    }
    await Bun.sleep(1200);

    await tab.evaluate(TYPE_TOKEN);
    await tab.evaluate(CLICK_VALIDATE);

    // Wait for the Validate verdict to be ON SCREEN before sampling — that
    // block existing is the precondition the tear-down checks measure against.
    let seeded = false;
    for (let i = 0; i < 40; i++) {
      const blocks = await tab
        .evaluate(`document.querySelectorAll('[role="status"], [role="alert"]').length`)
        .catch(() => 0);
      if (Number(blocks) > 0) {
        seeded = true;
        break;
      }
      await Bun.sleep(250);
    }
    if (!seeded) {
      console.error("Validate produced no visible verdict — the tear-down checks would be vacuous");
      process.exit(2);
    }

    await tab.evaluate(INSTALL_SAMPLER);
    await Bun.sleep(300);
    await tab.evaluate(CLICK_ADD);
    await Bun.sleep(4200);

    const raw = (await tab.evaluate(
      `JSON.stringify({ clickAt: window.__probe.clickAt, samples: window.__probe.samples })`
    )) as string;
    const { clickAt, samples } = JSON.parse(raw) as {
      clickAt: number;
      samples: Array<{
        t: number;
        opacity: string;
        btn: string;
        formH: number;
        blocks: number;
        sameBlock: boolean | null;
      }>;
    };

    const after = samples.filter((s) => s.t >= clickAt);
    const busyFrames = after.filter((s) => s.opacity !== "1" || s.btn !== "Add");
    const busyMs =
      busyFrames.length === 0
        ? 0
        : +((busyFrames[busyFrames.length - 1]?.t ?? 0) - (busyFrames[0]?.t ?? 0)).toFixed(1);

    // Did the block ever go away after having been there?
    const sawBlockBefore = samples.some((s) => s.t < clickAt && s.blocks > 0);
    const blockDroppedOut = sawBlockBefore && after.some((s) => s.blocks === 0);
    const blockReplaced = after.some((s) => s.sameBlock === false);

    const heights = after.map((s) => s.formH);
    const layoutJump = +(Math.max(...heights) - Math.min(...heights)).toFixed(1);

    const failures: string[] = [];
    if (busyMs > 0 && busyMs < 120) {
      failures.push(
        `busy affordance flashed for ${busyMs}ms — under the delay, it should not show at all`
      );
    }
    if (blockDroppedOut) failures.push("feedback block unmounted during the transition");
    if (blockReplaced) failures.push("feedback block was replaced by a different DOM node");
    if (layoutJump > MAX_LAYOUT_JUMP_PX) {
      failures.push(`form height moved ${layoutJump}px (max ${MAX_LAYOUT_JUMP_PX}px)`);
    }

    const report = {
      status: failures.length === 0 ? "PASS" : "FAIL",
      cockpit,
      busyAffordanceMs: busyMs,
      feedbackBlockDroppedOut: blockDroppedOut,
      feedbackBlockReplaced: blockReplaced,
      layoutJumpPx: layoutJump,
      framesSampled: samples.length,
      failures,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exit(failures.length === 0 ? 0 : 1);
  } finally {
    await tab.close();
  }
}

await main();
