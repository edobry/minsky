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
 */
import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyId } from "./CopyId";
import { entityToMinskyUri } from "../lib/entity-codec";

afterEach(cleanup);

const ASK_ID = "550e8400-e29b-41d4-a716-446655440000";

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

  test("Copy ID writes the bare full id to the clipboard and shows Copied feedback", async () => {
    const writeText = spyOn(navigator.clipboard, "writeText");
    render(<CopyId type="ask" id={ASK_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy ask id" }));
    fireEvent.click(await screen.findByText("Copy ID"));

    expect(writeText).toHaveBeenCalledWith(ASK_ID);

    // Icon/label swap: "Copied" feedback renders transiently. (The ~2s revert
    // itself is exercised deterministically, with a fake timer, in the nested
    // "copy feedback timing" describe block below — no real-time wait here.)
    await screen.findByText("Copied");
  });

  test("Copy link writes the ask's minsky:// deeplink (percent-encoded uuid) to the clipboard", async () => {
    const writeText = spyOn(navigator.clipboard, "writeText");
    render(<CopyId type="ask" id={ASK_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy ask id" }));
    fireEvent.click(await screen.findByText("Copy link"));

    const expected = entityToMinskyUri("ask", ASK_ID);
    expect(expected).toBe(`minsky://ask/${ASK_ID}`); // UUIDs need no percent-encoding
    expect(writeText).toHaveBeenCalledWith(expected);
    await screen.findByText("Copied");
  });

  test("Copy link for a task percent-encodes the '#' in the minsky:// deeplink", async () => {
    const writeText = spyOn(navigator.clipboard, "writeText");
    render(<CopyId type="task" id="mt#2410" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy task id" }));
    fireEvent.click(await screen.findByText("Copy link"));

    expect(writeText).toHaveBeenCalledWith("minsky://task/mt%232410");
  });

  test("displayId (mt#2965): renders the short id as the visible/title text, not the uuid", () => {
    render(<CopyId type="ask" id={ASK_ID} displayId="ask#7" />);
    const idEl = screen.getByTitle("ask#7");
    expect(idEl.textContent).toBe("ask#7");
    expect(screen.queryByTitle(ASK_ID)).toBeNull();
  });

  test("displayId (mt#2965): Copy ID copies the short id, not the uuid", async () => {
    const writeText = spyOn(navigator.clipboard, "writeText");
    render(<CopyId type="ask" id={ASK_ID} displayId="ask#7" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy ask id" }));
    fireEvent.click(await screen.findByText("Copy ID"));
    expect(writeText).toHaveBeenCalledWith("ask#7");
  });

  test("displayId (mt#2965): Copy link still targets the canonical uuid, never the short id", async () => {
    const writeText = spyOn(navigator.clipboard, "writeText");
    render(<CopyId type="ask" id={ASK_ID} displayId="ask#7" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy ask id" }));
    fireEvent.click(await screen.findByText("Copy link"));
    // mt#2946's decision: short ids never replace the uuid as the
    // minsky:// deeplink target.
    expect(writeText).toHaveBeenCalledWith(entityToMinskyUri("ask", ASK_ID));
  });

  test("omitting displayId is unaffected (regression): behaves exactly as before this prop existed", () => {
    render(<CopyId type="ask" id={ASK_ID} />);
    const idEl = screen.getByTitle(ASK_ID);
    expect(idEl.textContent).not.toBe(ASK_ID); // still truncated, same as the first test above
  });

  test("keyboard: Enter on the focused trigger opens the menu, Enter on the focused item activates it", async () => {
    const user = userEvent.setup();
    const writeText = spyOn(navigator.clipboard, "writeText");
    render(<CopyId type="ask" id={ASK_ID} />);

    const trigger = screen.getByRole("button", { name: "Copy ask id" });
    trigger.focus();
    await user.keyboard("{Enter}");

    const copyIdItem = await screen.findByText("Copy ID");
    copyIdItem.focus();
    await user.keyboard("{Enter}");

    expect(writeText).toHaveBeenCalledWith(ASK_ID);
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
      const writeText = spyOn(navigator.clipboard, "writeText");
      render(<CopyId type="ask" id={ASK_ID} />);

      fireEvent.click(screen.getByRole("button", { name: "Copy ask id" }));
      fireEvent.click(await screen.findByText("Copy ID"));

      expect(writeText).toHaveBeenCalledWith(ASK_ID);

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
