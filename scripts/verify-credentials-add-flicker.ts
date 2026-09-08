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

import { safeTruncate } from "@minsky/shared/safe-truncate";

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
 * There is deliberately NO busy-duration threshold here.
 *
 * The first version carried one (120 ms) under a comment claiming it was "tied
 * to the component's own delay rather than restated" — while the component used
 * 150 ms. The comment described an intention the code did not implement, which
 * is worse than an honest magic number: it tells the next reader the coupling
 * exists, so nobody checks.
 *
 * The fix is to drop the number rather than sync it. This probe always drives
 * the FAST path (a token every provider refuses, resolved well inside the
 * delay), so the correct assertion is absolute and needs no constant: a fast
 * operation must show **no** busy affordance at all. That holds however the
 * component's delay is later tuned, and cannot drift out of sync with it.
 *
 * A probe for the SLOW path — "work that outruns the delay does show a busy
 * state" — would need the constant, and is not attempted here; the component
 * test covers that direction.
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
  // PUT, not GET — and this is REQUIRED, not stylistic. A reviewer flagged GET
  // as the conventional verb (PR #3677); that convention predates Chrome's
  // change and modern Chrome refuses it. Measured against Chrome 152 rather
  // than argued, because the claim is about a third party's behaviour:
  //
  //   $ curl -X GET 'http://127.0.0.1:9337/json/new?about:blank'
  //   Using unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb.
  //   $ curl -X PUT 'http://127.0.0.1:9337/json/new?about:blank'
  //   { "description": "", "devtoolsFrontendUrl": … }
  //
  // Switching to GET would break the script on every current Chrome.
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?${url}`, { method: "PUT" });
  // Check the response before parsing it. Chrome answers this endpoint with
  // PLAIN TEXT on refusal (see the verb error quoted above), so `.json()` on a
  // non-2xx throws a JSON parse error — which reads as "the probe is broken"
  // rather than "Chrome refused to open a tab", and buries the actual reason
  // Chrome already told us. Reviewer finding, PR #3677.
  if (!res.ok) {
    const detail = safeTruncate((await res.text().catch(() => "")).trim(), 200, "head");
    throw new Error(`CDP refused to open a tab (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const tab = (await res.json().catch((err: unknown) => {
    throw new Error(
      `CDP returned a non-JSON body for /json/new: ${err instanceof Error ? err.message : String(err)}`
    );
  })) as { id: string; webSocketDebuggerUrl: string };
  if (!tab?.webSocketDebuggerUrl) {
    throw new Error("CDP opened a tab with no webSocketDebuggerUrl — cannot attach");
  }
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

/**
 * Every query is scoped to `#credentials-add-form`, and busy-ness is read from
 * `aria-busy` rather than from the Add button's label.
 *
 * Both were reviewer findings on PR #3677 and both are real. A global
 * `[role="status"]` sweep counts any live-region on the page — the settings
 * page has others — so an unrelated status node would have been read as this
 * form's feedback block. And keying busy-ness to the literal string "Add"
 * makes the probe fail the first time that copy is edited, reporting a flicker
 * regression for a rename.
 *
 * The form now carries the id and `aria-busy` as a deliberate contract for
 * exactly this; see the comment on its container.
 */
const INSTALL_SAMPLER = `
(() => {
  const form = document.querySelector('#credentials-add-form');
  const input = form.querySelector('#cred-token-input');
  const w = window;
  w.__probe = { t0: performance.now(), samples: [], firstBlockNode: null };
  const blocksIn = () => form.querySelectorAll('[role="status"], [role="alert"]');
  const sample = () => {
    const found = blocksIn();
    const block = found[0] || null;
    if (block && !w.__probe.firstBlockNode) w.__probe.firstBlockNode = block;
    w.__probe.samples.push({
      t: +(performance.now() - w.__probe.t0).toFixed(1),
      opacity: getComputedStyle(input).opacity,
      busy: form.getAttribute('aria-busy') === 'true',
      formH: +form.getBoundingClientRect().height.toFixed(1),
      blocks: found.length,
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

    // The form's `id` + `aria-busy` are the contract every query below depends
    // on, and they arrived WITH the fix. A build predating them would otherwise
    // die on a null dereference inside an in-page expression — an error that
    // reads like a broken probe rather than an unsupported target. Say which.
    if (ready) {
      const hasContract = await tab
        .evaluate(`!!document.querySelector('#credentials-add-form')`)
        .catch(() => false);
      if (hasContract !== true) {
        console.error(
          "this cockpit predates the #credentials-add-form contract (mt#5032) — " +
            "the probe cannot measure it; point at a build that includes the fix"
        );
        process.exit(2);
      }
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
        .evaluate(
          `document.querySelectorAll('#credentials-add-form [role="status"], #credentials-add-form [role="alert"]').length`
        )
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
        busy: boolean;
        formH: number;
        blocks: number;
        sameBlock: boolean | null;
      }>;
    };

    const after = samples.filter((s) => s.t >= clickAt);
    // Either signal counts: the form declaring itself busy, or the input
    // visibly faded. Neither depends on copy.
    const busyFrames = after.filter((s) => s.busy || s.opacity !== "1");
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
    if (busyFrames.length > 0) {
      failures.push(
        `busy affordance appeared for ${busyMs}ms on a fast operation — it should not show at all`
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
