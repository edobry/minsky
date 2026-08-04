/**
 * CopyId tests (mt#2943).
 *
 * PR #2073 R2: the original "Copy ID ... toggles Copy -> Check feedback" test
 * asserted the ~2s revert via a real-time `waitFor(..., {timeout: 3000})` —
 * passed locally, timed out at 5.5s on the slower CI runner (classic
 * real-timer flake; see PR #2073 CI failure). bun:test has no
 * `advanceTimersByTime`-style fake-timer engine (only `setSystemTime` for
 * `Date`, per `bun-types/test.d.ts` — confirmed no other cockpit test fakes
 * timers), so the revert-timing test below installs a minimal scoped fake
 * for `globalThis.setTimeout` itself: capture the scheduled callback/delay
 * instead of letting a real clock fire it, then invoke the callback manually
 * inside `act(...)` to deterministically "advance" the timer. Scoped to its
 * own nested `describe` with its own `beforeEach`/`afterEach` so the fake
 * never leaks into the other (real-timer, sub-second) tests in this file.
 *
 * mt#3629 / mt#3565 §Reframe: the ADR-029 / mt#2946 copy-payload policy
 * (short-id Copy-ID payload, canonical-uuid link target, `%23` encoding) is
 * now `buildCopyPayload(type, id, displayId, action)`, a pure function
 * asserted directly by return value — no clipboard, no DOM, no spy. The
 * remaining component tests below are WIRING tests: they verify clicking
 * (or keyboard-activating) the real rendered buttons actually reaches the
 * real clipboard. happy-dom 20.9 ships a real `Clipboard` implementation
 * (`node_modules/happy-dom/src/clipboard/Clipboard.ts`) backed by an
 * in-memory store with `writeText`/`readText`, and its `Permissions.query`
 * defaults every permission name to `'granted'`
 * (`node_modules/happy-dom/src/permissions/Permissions.ts:55`) — so
 * `navigator.clipboard.writeText()` genuinely works under happy-dom with no
 * setup required, and a wiring test can read the value BACK via
 * `navigator.clipboard.readText()` instead of patching `writeText` with a
 * spy. VERIFIED LIVE this session (mt#3629 AT3 — the interop mt#3565 flagged
 * UNVERIFIED): every test below drives the DOM with
 * `@testing-library/user-event` and asserts on the real clipboard's content;
 * no fallback to an injected copy-function prop was needed.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyId, buildCopyPayload } from "./CopyId";
import { entityToMinskyUri } from "../lib/entity-codec";

afterEach(cleanup);

const ASK_ID = "550e8400-e29b-41d4-a716-446655440000";

// ---------------------------------------------------------------------------
// Pure-core tests: buildCopyPayload (the ADR-029 / mt#2946 policy)
// ---------------------------------------------------------------------------

describe("buildCopyPayload (pure core)", () => {
  test("id action: no displayId copies the canonical id", () => {
    expect(buildCopyPayload("ask", ASK_ID, undefined, "id")).toBe(ASK_ID);
  });

  test("id action: a displayId (short id) wins over the canonical id (mt#2965)", () => {
    expect(buildCopyPayload("ask", ASK_ID, "ask#7", "id")).toBe("ask#7");
  });

  test("link action: no displayId — the deeplink targets the canonical id, uuid needs no encoding", () => {
    const payload = buildCopyPayload("ask", ASK_ID, undefined, "link");
    expect(payload).toBe(`minsky://ask/${ASK_ID}`);
    expect(payload).toBe(entityToMinskyUri("ask", ASK_ID));
  });

  test("link action: a displayId is present but NEVER substitutes the link target (mt#2946)", () => {
    const payload = buildCopyPayload("ask", ASK_ID, "ask#7", "link");
    expect(payload).toBe(entityToMinskyUri("ask", ASK_ID));
    expect(payload).not.toContain("ask#7");
  });

  test("link action: a task id's '#' is percent-encoded (AT2)", () => {
    expect(buildCopyPayload("task", "mt#2410", undefined, "link")).toBe(
      "minsky://task/mt%232410"
    );
  });
});

// ---------------------------------------------------------------------------
// Rendering tests (no clipboard involved)
// ---------------------------------------------------------------------------

describe("CopyId", () => {
  test("renders a long id as truncated, selectable monospace text with the full id in the title", () => {
    render(<CopyId type="ask" id={ASK_ID} />);
    const idEl = screen.getByTitle(ASK_ID);
    expect(idEl.className).toContain("select-all");
    expect(idEl.className).toContain("font-mono");
    // Display is truncated (shortenId default 8 code points + ellipsis) — not the full 36-char UUID.
    expect(idEl.textContent).not.toBe(ASK_ID);
    expect(idEl.textContent?.endsWith("…")).toBe(true);
  });

  test("short ids (e.g. a task's mt#... id) are rendered in full, not force-truncated", () => {
    render(<CopyId type="task" id="mt#2410" />);
    const idEl = screen.getByTitle("mt#2410");
    expect(idEl.textContent).toBe("mt#2410");
  });

  test("trigger has an aria-label", () => {
    render(<CopyId type="ask" id={ASK_ID} />);
    expect(screen.getByRole("button", { name: "Copy ask id" })).toBeTruthy();
  });

  test("displayId (mt#2965): renders the short id as the visible/title text, not the uuid", () => {
    render(<CopyId type="ask" id={ASK_ID} displayId="ask#7" />);
    const idEl = screen.getByTitle("ask#7");
    expect(idEl.textContent).toBe("ask#7");
    expect(screen.queryByTitle(ASK_ID)).toBeNull();
  });

  test("omitting displayId is unaffected (regression): behaves exactly as before this prop existed", () => {
    render(<CopyId type="ask" id={ASK_ID} />);
    const idEl = screen.getByTitle(ASK_ID);
    expect(idEl.textContent).not.toBe(ASK_ID); // still truncated, same as the first test above
  });
});

// ---------------------------------------------------------------------------
// Wiring tests: clicking/activating the real buttons reaches the real
// clipboard (mt#3629). No spyOn anywhere below — every assertion reads
// navigator.clipboard.readText() back, which happy-dom backs with a real
// in-memory store (see file header).
// ---------------------------------------------------------------------------

describe("CopyId — wiring (real clipboard via happy-dom, driven by user-event)", () => {
  test("mouse: Copy ID writes buildCopyPayload's \"id\" payload to the clipboard and shows Copied feedback", async () => {
    const user = userEvent.setup();
    render(<CopyId type="ask" id={ASK_ID} />);

    await user.click(screen.getByRole("button", { name: "Copy ask id" }));
    await user.click(await screen.findByText("Copy ID"));

    expect(await navigator.clipboard.readText()).toBe(buildCopyPayload("ask", ASK_ID, undefined, "id"));
    // Icon/label swap: "Copied" feedback renders transiently. (The ~2s revert
    // itself is exercised deterministically, with a fake timer, in the
    // "copy feedback timing" describe block below — no real-time wait here.)
    await screen.findByText("Copied");
  });

  test("mouse: Copy link writes buildCopyPayload's \"link\" payload to the clipboard", async () => {
    const user = userEvent.setup();
    render(<CopyId type="task" id="mt#2410" />);

    await user.click(screen.getByRole("button", { name: "Copy task id" }));
    await user.click(await screen.findByText("Copy link"));

    expect(await navigator.clipboard.readText()).toBe(
      buildCopyPayload("task", "mt#2410", undefined, "link")
    );
  });

  test("keyboard: Enter on the focused trigger opens the menu, Enter on the focused item activates it", async () => {
    const user = userEvent.setup();
    render(<CopyId type="ask" id={ASK_ID} />);

    const trigger = screen.getByRole("button", { name: "Copy ask id" });
    trigger.focus();
    await user.keyboard("{Enter}");

    const copyIdItem = await screen.findByText("Copy ID");
    copyIdItem.focus();
    await user.keyboard("{Enter}");

    expect(await navigator.clipboard.readText()).toBe(ASK_ID);
  });

  describe("copy feedback timing (deterministic fake timer)", () => {
    let originalSetTimeout: typeof globalThis.setTimeout;
    let pendingTimerCallback: (() => void) | null;
    let pendingTimerDelay: number | null;

    beforeEach(() => {
      originalSetTimeout = globalThis.setTimeout;
      pendingTimerCallback = null;
      pendingTimerDelay = null;
      // Minimal scoped fake: capture ONLY CopyId's own revert timer (doCopy's
      // `setTimeout(() => setCopied(null), 2000)`, identified by its 2000ms
      // delay) instead of a real clock firing it. Every OTHER setTimeout call
      // (notably @testing-library/react's own findBy/waitFor polling, which
      // also runs on setTimeout under the hood) passes through to the real
      // implementation — faking indiscriminately hung findByText forever in
      // an earlier version of this test.
      globalThis.setTimeout = ((cb: () => void, delay?: number, ...args: unknown[]) => {
        if (delay === 2000) {
          pendingTimerCallback = cb;
          pendingTimerDelay = delay;
          return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
        }
        return originalSetTimeout(cb, delay, ...args);
      }) as typeof globalThis.setTimeout;
    });

    afterEach(() => {
      globalThis.setTimeout = originalSetTimeout;
    });

    test("Copy -> Check feedback reverts once the ~2s timer is advanced (not before)", async () => {
      const user = userEvent.setup();
      render(<CopyId type="ask" id={ASK_ID} />);

      await user.click(screen.getByRole("button", { name: "Copy ask id" }));
      await user.click(await screen.findByText("Copy ID"));

      expect(await navigator.clipboard.readText()).toBe(ASK_ID);

      // Immediate, deterministic: feedback renders off the clipboard promise
      // resolution, independent of the (faked) revert timer.
      await screen.findByText("Copied");
      expect(pendingTimerDelay).toBe(2000);

      // Still present before the timer fires — reversion is timer-driven, not incidental.
      expect(screen.queryByText("Copied")).not.toBeNull();

      // Deterministically "advance" the fake ~2s timer — no real-time wait.
      act(() => {
        pendingTimerCallback?.();
      });

      expect(screen.queryByText("Copied")).toBeNull();
    });
  });
});
