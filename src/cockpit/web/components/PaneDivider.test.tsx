/**
 * PaneDivider interaction tests (mt#3701).
 *
 * The divider REPORTS a requested width and the host clamps, so these assert on
 * what it reports — no geometry is involved, which is what makes the behavior
 * testable under happy-dom at all. The host-side clamp is covered by
 * `lib/pane-width.test.ts`, and the real box model by
 * `scripts/verify-session-film-panes.ts`.
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/components/PaneDivider.test.tsx
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PaneDivider, PANE_DIVIDER_STEP_PX, PANE_DIVIDER_COARSE_STEP_PX } from "./PaneDivider";

const START_WIDTH = 256;

afterEach(cleanup);

function renderDivider(overrides: Partial<Parameters<typeof PaneDivider>[0]> = {}) {
  const changes: number[] = [];
  let resets = 0;
  render(
    <PaneDivider
      value={START_WIDTH}
      min={192}
      max={640}
      onChange={(next) => changes.push(next)}
      onReset={() => {
        resets += 1;
      }}
      label="Resize the event ribbon"
      data-testid="divider"
      {...overrides}
    />
  );
  return {
    divider: screen.getByTestId("divider"),
    changes,
    resetCount: () => resets,
  };
}

describe("PaneDivider — the handle is visible, not a hidden hit area (mt#3701 SC 1)", () => {
  test("renders a grip mark alongside the seam", () => {
    renderDivider();
    // The affordance IS the point: a resize target discoverable only by
    // sweeping the mouse across a seam is a feature only its author knows about.
    expect(screen.getByTestId("divider-grip")).toBeDefined();
  });

  test("carries the separator role and a live value range", () => {
    const { divider } = renderDivider();
    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.getAttribute("aria-orientation")).toBe("vertical");
    expect(divider.getAttribute("aria-label")).toBe("Resize the event ribbon");
    expect(divider.getAttribute("aria-valuenow")).toBe(String(START_WIDTH));
    expect(divider.getAttribute("aria-valuemin")).toBe("192");
    expect(divider.getAttribute("aria-valuemax")).toBe("640");
    expect(divider.getAttribute("tabindex")).toBe("0");
  });
});

describe("PaneDivider — dragging (mt#3701 SC 2)", () => {
  test("reports the pointer delta against the width at pointer-down", () => {
    const { divider, changes } = renderDivider();

    fireEvent.pointerDown(divider, { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 460 });
    fireEvent.pointerMove(window, { clientX: 520 });
    fireEvent.pointerUp(window, { clientX: 520 });

    // Absolute against the drag origin, not cumulative against the last report:
    // a host that clamps would otherwise make the divider drift away from the
    // pointer over a long drag.
    expect(changes).toEqual([START_WIDTH + 60, START_WIDTH + 120]);
  });

  test("stops reporting after the pointer is released", () => {
    const { divider, changes } = renderDivider();

    fireEvent.pointerDown(divider, { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 450 });
    fireEvent.pointerUp(window, { clientX: 450 });
    fireEvent.pointerMove(window, { clientX: 900 });

    expect(changes).toEqual([START_WIDTH + 50]);
  });

  test("ignores a non-primary button", () => {
    const { divider, changes } = renderDivider();

    fireEvent.pointerDown(divider, { clientX: 400, button: 2 });
    fireEvent.pointerMove(window, { clientX: 500 });

    expect(changes).toEqual([]);
  });

  test("marks itself as dragging only while the pointer is down", () => {
    const { divider } = renderDivider();

    expect(divider.getAttribute("data-dragging")).toBeNull();
    fireEvent.pointerDown(divider, { clientX: 400, button: 0 });
    expect(divider.getAttribute("data-dragging")).toBe("true");
    fireEvent.pointerUp(window, { clientX: 400 });
    expect(divider.getAttribute("data-dragging")).toBeNull();
  });
});

describe("PaneDivider — keyboard operation (mt#3701 SC 3)", () => {
  test("arrow keys step, shift steps coarser", () => {
    const { divider, changes } = renderDivider();

    fireEvent.keyDown(divider, { key: "ArrowRight" });
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    fireEvent.keyDown(divider, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(divider, { key: "ArrowLeft", shiftKey: true });

    expect(changes).toEqual([
      START_WIDTH + PANE_DIVIDER_STEP_PX,
      START_WIDTH - PANE_DIVIDER_STEP_PX,
      START_WIDTH + PANE_DIVIDER_COARSE_STEP_PX,
      START_WIDTH - PANE_DIVIDER_COARSE_STEP_PX,
    ]);
  });

  test("Home and double-click both restore the default", () => {
    const { divider, changes, resetCount } = renderDivider();

    fireEvent.keyDown(divider, { key: "Home" });
    fireEvent.doubleClick(divider);

    expect(resetCount()).toBe(2);
    expect(changes).toEqual([]);
  });

  test("leaves unrelated keys alone", () => {
    const { divider, changes, resetCount } = renderDivider();

    fireEvent.keyDown(divider, { key: "ArrowDown" });
    fireEvent.keyDown(divider, { key: "a" });

    expect(changes).toEqual([]);
    expect(resetCount()).toBe(0);
  });

  test("a handled keystroke does not continue past the divider", () => {
    // The mechanism behind SC 4: a host may run its own window-level arrow-key
    // shortcut (SessionFilm steps the film playhead), and React attaches its
    // listeners at the root container — below window — so stopping propagation
    // here is what keeps a resize from also driving that shortcut. Asserted at
    // the window, which is exactly where such a host listens.
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as KeyboardEvent).key);
    window.addEventListener("keydown", listener);
    try {
      const { divider } = renderDivider();
      fireEvent.keyDown(divider, { key: "ArrowRight" });
      expect(seen).toEqual([]);

      // Control: an unhandled key from the same element DOES reach the window,
      // so the assertion above is about stopPropagation and not about the
      // harness failing to deliver keydown at all.
      fireEvent.keyDown(divider, { key: "ArrowDown" });
      expect(seen).toEqual(["ArrowDown"]);
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });
});

describe("PaneDivider — which side it sizes (mt#4261)", () => {
  test("defaults to the pane on its LEFT, unchanged from mt#3701", () => {
    // The film host passes no `resizes`, so this is the regression guard for it:
    // every assertion in the two suites above depends on this default holding.
    const { divider, changes } = renderDivider();

    fireEvent.pointerDown(divider, { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 460 });

    expect(changes).toEqual([START_WIDTH + 60]);
  });

  test("sizes the pane on its RIGHT when asked — dragging LEFT widens", () => {
    const { divider, changes } = renderDivider({ resizes: "right" });

    // Same gesture as the default-case test above, opposite meaning: on a
    // right-anchored assembly the divider sits at the left edge, so moving the
    // pointer RIGHT eats into the pane.
    fireEvent.pointerDown(divider, { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 460 });
    fireEvent.pointerMove(window, { clientX: 340 });

    expect(changes).toEqual([START_WIDTH - 60, START_WIDTH + 60]);
  });

  test("mirrors the arrow keys with the drag", () => {
    const { divider, changes } = renderDivider({ resizes: "right" });

    // The APG defines these by where the SPLITTER moves, not by whether the pane
    // grows — so ArrowLeft is the widening direction here.
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    fireEvent.keyDown(divider, { key: "ArrowRight" });

    expect(changes).toEqual([
      START_WIDTH + PANE_DIVIDER_STEP_PX,
      START_WIDTH - PANE_DIVIDER_STEP_PX,
    ]);
  });

  test("Home still resets, whichever side it sizes", () => {
    const { divider, resetCount } = renderDivider({ resizes: "right" });

    fireEvent.keyDown(divider, { key: "Home" });

    expect(resetCount()).toBe(1);
  });
});

describe("PaneDivider — onChange is live, onCommit is settled (mt#4274)", () => {
  function renderWithCommit(overrides: Partial<Parameters<typeof PaneDivider>[0]> = {}) {
    const commits: number[] = [];
    const r = renderDivider({ onCommit: (n: number) => commits.push(n), ...overrides });
    return { ...r, commits };
  }

  test("a drag reports every move but commits only once, on release", () => {
    const { divider, changes, commits } = renderWithCommit();

    fireEvent.pointerDown(divider, { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 440 });
    fireEvent.pointerMove(window, { clientX: 480 });
    fireEvent.pointerMove(window, { clientX: 520 });

    // Three live values, nothing settled yet — this split is the whole fix:
    // the host paints from `onChange` and only records from `onCommit`.
    expect(changes).toEqual([START_WIDTH + 40, START_WIDTH + 80, START_WIDTH + 120]);
    expect(commits).toEqual([]);

    fireEvent.pointerUp(window, { clientX: 520 });
    expect(commits).toEqual([START_WIDTH + 120]);
  });

  test("a click that never moves commits NOTHING", () => {
    // Regression: `lastReportedRef` was seeded with the current width at
    // pointerdown, so a bare click recorded a preference — which broke the
    // double-click reset, since its two clicks each committed a width before
    // `onReset` could clear one. Caught by scripts/verify-peek-resize.ts.
    const { divider, changes, commits } = renderWithCommit();

    fireEvent.pointerDown(divider, { clientX: 400, button: 0 });
    fireEvent.pointerUp(window, { clientX: 400 });

    expect(changes).toEqual([]);
    expect(commits).toEqual([]);
  });

  test("a keyboard step commits immediately — there is no release to wait for", () => {
    const { divider, changes, commits } = renderWithCommit();

    fireEvent.keyDown(divider, { key: "ArrowRight" });

    expect(changes).toEqual([START_WIDTH + PANE_DIVIDER_STEP_PX]);
    expect(commits).toEqual([START_WIDTH + PANE_DIVIDER_STEP_PX]);
  });

  test("Home resets and commits nothing — the host clears rather than records", () => {
    const { divider, commits, resetCount } = renderWithCommit();

    fireEvent.keyDown(divider, { key: "Home" });

    expect(resetCount()).toBe(1);
    expect(commits).toEqual([]);
  });

  test("aria-valuenow tracks the drag while the host's `value` prop stays put", () => {
    // The host deliberately does not re-render mid-drag, so `value` is frozen at
    // START_WIDTH throughout. Without the divider's own live value the announced
    // width would be frozen too, while the pane visibly moved.
    const { divider } = renderWithCommit();
    expect(divider.getAttribute("aria-valuenow")).toBe(String(START_WIDTH));

    fireEvent.pointerDown(divider, { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 500 });
    expect(divider.getAttribute("aria-valuenow")).toBe(String(START_WIDTH + 100));

    fireEvent.pointerUp(window, { clientX: 500 });
    // Back to the host's value once the drag ends — the host is the source of
    // truth again, and in the real assembly it has just been committed to.
    expect(divider.getAttribute("aria-valuenow")).toBe(String(START_WIDTH));
  });

  test("aria-valuenow never announces outside the range it also announces", () => {
    // `liveValue` is what the POINTER asked for, not what the host will render.
    // Dragging past the ceiling keeps climbing, so without a clamp the element
    // would report a `valuenow` above its own `valuemax` — an announced range
    // the pane can never be in. (PR #3121 R1, BLOCKING.)
    const { divider, changes } = renderWithCommit();
    const max = Number(divider.getAttribute("aria-valuemax"));
    const min = Number(divider.getAttribute("aria-valuemin"));

    fireEvent.pointerDown(divider, { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 400 + 5000 });
    expect(Number(divider.getAttribute("aria-valuenow"))).toBe(max);

    fireEvent.pointerMove(window, { clientX: 400 - 5000 });
    expect(Number(divider.getAttribute("aria-valuenow"))).toBe(min);

    // The REPORTED values are still the raw request — the host owns clamping
    // what renders, and this clamp is only about what is announced.
    expect(changes).toEqual([START_WIDTH + 5000, START_WIDTH - 5000]);
  });

  test("a host that passes no onCommit still works — SessionFilm's shape", () => {
    const { divider, changes } = renderDivider();

    fireEvent.pointerDown(divider, { clientX: 400, button: 0 });
    fireEvent.pointerMove(window, { clientX: 460 });
    fireEvent.pointerUp(window, { clientX: 460 });
    fireEvent.keyDown(divider, { key: "ArrowRight" });

    expect(changes).toEqual([START_WIDTH + 60, START_WIDTH + PANE_DIVIDER_STEP_PX]);
  });
});

describe("PaneDivider — aria-controls names what it sizes (mt#4261)", () => {
  test("carries the host's id list when given one", () => {
    const { divider } = renderDivider({ controls: "peek-pane-0 peek-pane-1" });
    expect(divider.getAttribute("aria-controls")).toBe("peek-pane-0 peek-pane-1");
  });

  test("omits the attribute entirely when the host has no id to name", () => {
    // Not the empty string: an `aria-controls` resolving to nothing is worse
    // than its absence, which is why the prop is optional.
    const { divider } = renderDivider();
    expect(divider.getAttribute("aria-controls")).toBeNull();
  });
});
