/**
 * PanZoomSVG tests (mt#2380)
 *
 * Covers:
 *   - Renders the SVG container and children.
 *   - Zoom-control buttons are present, keyboard-focusable, and ARIA-labelled.
 *   - Reset button is present with the correct ARIA label.
 *   - The SVG has the expected aria-label.
 *   - Firing wheel events updates the viewBox (zoom toward cursor).
 *   - Pointer drag updates the viewBox (pan).
 *
 * Run via: bun test --preload ./tests/dom-setup.ts src/cockpit/web/components/PanZoomSVG.test.tsx
 */
import { describe, test, expect, afterEach, beforeEach, setSystemTime } from "bun:test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { PanZoomSVG } from "./PanZoomSVG";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse an SVG viewBox string "x y w h" into numbers (throws on malformed input). */
function parseViewBox(vb: string): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = vb.split(" ").map(Number);
  if (x === undefined || y === undefined || w === undefined || h === undefined) {
    throw new Error(`parseViewBox: expected "x y w h", got "${vb}"`);
  }
  return { x, y, w, h };
}

function renderPanZoom(children?: React.ReactNode) {
  return render(
    <PanZoomSVG
      boardWidth={1280}
      boardHeight={820}
      ariaLabel="Test schematic"
    >
      {children ?? <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />}
    </PanZoomSVG>
  );
}

// ---------------------------------------------------------------------------
// Render / a11y
// ---------------------------------------------------------------------------

describe("PanZoomSVG — render and a11y", () => {
  test("renders the container with data-testid", () => {
    renderPanZoom();
    expect(screen.getByTestId("pan-zoom-svg-container")).toBeDefined();
  });

  test("renders the SVG with the supplied aria-label", () => {
    renderPanZoom();
    const svg = screen.getByRole("img", { name: "Test schematic" });
    expect(svg).toBeDefined();
  });

  test("renders children inside the SVG", () => {
    renderPanZoom();
    expect(screen.getByTestId("inner-rect")).toBeDefined();
  });

  test("zoom-in button is present and ARIA-labelled", () => {
    renderPanZoom();
    const btn = screen.getByRole("button", { name: "Zoom in" });
    expect(btn).toBeDefined();
  });

  test("zoom-out button is present and ARIA-labelled", () => {
    renderPanZoom();
    const btn = screen.getByRole("button", { name: "Zoom out" });
    expect(btn).toBeDefined();
  });

  test("reset button is present and ARIA-labelled", () => {
    renderPanZoom();
    const btn = screen.getByRole("button", { name: /reset/i });
    expect(btn).toBeDefined();
  });

  test("zoom controls are grouped with an accessible label", () => {
    renderPanZoom();
    const group = screen.getByRole("group", { name: "Zoom controls" });
    expect(group).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// viewBox state — zoom via wheel
// ---------------------------------------------------------------------------

describe("PanZoomSVG — wheel zoom", () => {
  test("wheel event changes the SVG viewBox attribute", () => {
    renderPanZoom();
    const svg = screen.getByTestId("pan-zoom-svg");

    // Capture the initial viewBox
    const initialViewBox = svg.getAttribute("viewBox");
    expect(initialViewBox).toBeDefined();

    // Dispatch a wheel event (deltaY < 0 = zoom in)
    fireEvent.wheel(svg, { deltaY: -200, clientX: 640, clientY: 400 });

    const afterViewBox = svg.getAttribute("viewBox");
    // The viewBox should differ from the initial state after zooming
    expect(afterViewBox).not.toEqual(initialViewBox);
  });

  test("zoom-in button narrows the viewBox width (zooms in)", () => {
    renderPanZoom();
    const svg = screen.getByTestId("pan-zoom-svg");

    const initialVB = svg.getAttribute("viewBox") ?? "";
    const initialW = parseViewBox(initialVB).w;

    const zoomInBtn = screen.getByRole("button", { name: "Zoom in" });
    fireEvent.click(zoomInBtn);

    const afterVB = svg.getAttribute("viewBox") ?? "";
    const afterW = parseViewBox(afterVB).w;

    // A zoom-in reduces the viewBox width (shows a smaller coordinate region)
    expect(afterW).toBeLessThan(initialW);
  });

  test("zoom-out button widens the viewBox width (zooms out)", () => {
    renderPanZoom();
    const svg = screen.getByTestId("pan-zoom-svg");

    // First zoom in so there's room to zoom out
    const zoomInBtn = screen.getByRole("button", { name: "Zoom in" });
    fireEvent.click(zoomInBtn);

    const midVB = svg.getAttribute("viewBox") ?? "";
    const midW = parseViewBox(midVB).w;

    const zoomOutBtn = screen.getByRole("button", { name: "Zoom out" });
    fireEvent.click(zoomOutBtn);

    const afterVB = svg.getAttribute("viewBox") ?? "";
    const afterW = parseViewBox(afterVB).w;

    expect(afterW).toBeGreaterThan(midW);
  });
});

// ---------------------------------------------------------------------------
// viewBox state — pointer drag (pan)
// ---------------------------------------------------------------------------

describe("PanZoomSVG — pointer drag pan", () => {
  test("pointer drag translates the viewBox origin", () => {
    renderPanZoom();
    const svg = screen.getByTestId("pan-zoom-svg");

    const initialVB = svg.getAttribute("viewBox") ?? "";
    const { x: initialX, y: initialY } = parseViewBox(initialVB);

    // Simulate a drag: pointerdown at (300, 300), pointermove to (200, 250)
    // dragging left+up should move the viewBox right+down (pan right+down)
    fireEvent.pointerDown(svg, { button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(svg, { clientX: 200, clientY: 250 });
    fireEvent.pointerUp(svg);

    const afterVB = svg.getAttribute("viewBox") ?? "";
    const { x: afterX, y: afterY } = parseViewBox(afterVB);

    // x should have increased (panned right), y should have increased (panned down)
    expect(afterX).toBeGreaterThan(initialX);
    expect(afterY).toBeGreaterThan(initialY);
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("PanZoomSVG — reset", () => {
  test("reset button restores the viewBox close to fit-width defaults", () => {
    renderPanZoom();
    const svg = screen.getByTestId("pan-zoom-svg");

    // Record initial state (which is the fit-width default, or boardWidth fallback)
    const initialVB = svg.getAttribute("viewBox") ?? "";

    // Zoom in several times
    const zoomInBtn = screen.getByRole("button", { name: "Zoom in" });
    fireEvent.click(zoomInBtn);
    fireEvent.click(zoomInBtn);
    fireEvent.click(zoomInBtn);

    const zoomedVB = svg.getAttribute("viewBox") ?? "";
    expect(zoomedVB).not.toEqual(initialVB);

    // Reset
    const resetBtn = screen.getByRole("button", { name: /reset/i });
    fireEvent.click(resetBtn);

    // After reset the viewBox width should be back to boardWidth (1280) in JSDOM
    // (getBoundingClientRect returns 0 in JSDOM so applyFitWidth falls back to
    // the initial boardWidth×boardHeight state).
    const resetVB = svg.getAttribute("viewBox") ?? "";
    const resetW = parseViewBox(resetVB).w;
    // In JSDOM getBoundingClientRect returns 0, so fit-width cannot be computed;
    // the initial state has w=1280. The reset should have returned to a wider view.
    expect(resetW).toBeGreaterThan(parseViewBox(zoomedVB).w);
  });
});

// ---------------------------------------------------------------------------
// Aspect-ratio stability (mt#2380 R1 — no distortion on non-1280×820 containers)
// ---------------------------------------------------------------------------

describe("PanZoomSVG — aspect-ratio stability", () => {
  test("viewBox aspect tracks the container aspect through fit and zoom (no distortion)", () => {
    renderPanZoom();
    const container = screen.getByTestId("pan-zoom-svg-container");
    const svg = screen.getByTestId("pan-zoom-svg");

    // Simulate a non-board-aspect container: 1600×400 (4:1, vs the board's 1280:820).
    const rect = {
      width: 1600,
      height: 400,
      top: 0,
      left: 0,
      right: 1600,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect;
    container.getBoundingClientRect = () => rect;

    const aspect = (): number => {
      const { w, h } = parseViewBox(svg.getAttribute("viewBox") ?? "");
      return w / h;
    };
    const width = (): number => parseViewBox(svg.getAttribute("viewBox") ?? "").w;

    // Reset → fit-width at the container aspect.
    fireEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(aspect()).toBeCloseTo(1600 / 400, 3);
    const fitW = width();

    // Zoom in — the viewBox aspect MUST still equal the container aspect; if the
    // zoom math reverted to the board aspect, this would fail (circles → ovals).
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(aspect()).toBeCloseTo(1600 / 400, 3);
    expect(width()).toBeLessThan(fitW);
  });
});

// ---------------------------------------------------------------------------
// Timer-driven camera effects (mt#3247 R1, non-blocking #3): ambient drift
// (setInterval) and the growing-bounds/camera-follow tick chain (recursive
// setTimeout) previously slept on the REAL clock (`await new Promise((r) =>
// setTimeout(r, N))`) — correct locally, but a loaded CI runner can miss a
// real ~20-260ms window and flake (the exact failure class this fix exists
// to prevent). bun:test has no `advanceTimersByTime`-style fake-timer engine
// (only `setSystemTime` for `Date` — see CopyId.test.tsx's precedent, which
// hand-rolls a MINIMAL scoped `setTimeout` fake rather than faking
// indiscriminately, since an unscoped fake risks starving
// @testing-library's own setTimeout-based polling). PanZoomSVG's timer usage
// is more involved (a fixed-200ms `setInterval` PLUS a recursive `setTimeout`
// chain with variable delays), so this hand-rolls a small virtual clock:
//
//   - `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval` are replaced
//     with an in-memory queue, fired in time order by `FakeClock.advance()`
//     — including timers a firing callback schedules (the growing-bounds
//     effect's own `scheduleTick` chain depends on this), matching a real
//     clock's semantics.
//   - `Date.now()` is kept in lockstep via `setSystemTime` as the virtual
//     clock advances, since the component's OWN easing/wobble math reads
//     `Date.now()` directly (not a timer's delay argument) to compute
//     elapsed time — without this, ease-convergence assertions below would
//     never converge (real wall-clock time elapsed during a synchronous test
//     body is microseconds, not the hundreds of ms the eases need).
//
// Safe to fake `globalThis.setTimeout`/`setInterval` globally within this
// scope: React's scheduler (`node_modules/scheduler`) captures its OWN timer
// references (`localSetImmediate`/`localSetTimeout`) once at module load,
// long before this file's `beforeEach` runs, and prefers `setImmediate` over
// `setTimeout` in Bun (Node-compatible) for its work-loop scheduling anyway —
// so swapping `globalThis.setTimeout` here never touches React's internal
// scheduling. None of the tests below use `waitFor`/`findBy` (RTL's own
// setTimeout-based polling), so there is nothing else to starve.
//
// Scoped to ONE wrapping describe (installed/restored per-test) so the fake
// never leaks into the synchronous (fireEvent-only) describes above —
// matching CopyId.test.tsx's "never leak into other tests" discipline.
// ---------------------------------------------------------------------------

function mockRect(width: number, height: number): DOMRect {
  return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} } as DOMRect;
}

interface FakeTimerEntry {
  id: number;
  due: number;
  cb: () => void;
  intervalMs: number | null;
}

class FakeClock {
  private nowMs = Date.now();
  private nextId = 1;
  private timers: FakeTimerEntry[] = [];

  setTimeout = ((cb: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id = this.nextId++;
    this.timers.push({ id, due: this.nowMs + Math.max(0, delay ?? 0), cb: () => cb(...args), intervalMs: null });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;

  clearTimeout = ((id?: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== id);
  }) as typeof globalThis.clearTimeout;

  setInterval = ((cb: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const id = this.nextId++;
    const intervalMs = Math.max(0, delay ?? 0);
    this.timers.push({ id, due: this.nowMs + intervalMs, cb: () => cb(...args), intervalMs });
    return id as unknown as ReturnType<typeof globalThis.setInterval>;
  }) as typeof globalThis.setInterval;

  clearInterval = ((id?: unknown) => {
    this.timers = this.timers.filter((t) => t.id !== id);
  }) as typeof globalThis.clearInterval;

  /**
   * Advance the virtual clock by `ms`, firing every timer due at or before
   * the target time, in time order — including timers newly scheduled by an
   * already-firing callback (the growing-bounds effect's recursive
   * `scheduleTick` chain depends on this). `Date.now()` is advanced in
   * lockstep via `setSystemTime` immediately before each callback fires.
   */
  advance(ms: number): void {
    const target = this.nowMs + ms;
    let guard = 0;
    for (;;) {
      this.timers.sort((a, b) => a.due - b.due);
      const next = this.timers[0];
      if (!next || next.due > target) break;
      this.nowMs = next.due;
      setSystemTime(this.nowMs);
      if (next.intervalMs !== null) {
        next.due = this.nowMs + next.intervalMs;
      } else {
        this.timers.shift();
      }
      next.cb();
      if (++guard > 100_000) {
        throw new Error("FakeClock.advance: exceeded max timer iterations (possible infinite timer loop)");
      }
    }
    this.nowMs = target;
    setSystemTime(this.nowMs);
  }
}

describe("PanZoomSVG — timer-driven camera effects (fake clock, mt#3247 R1)", () => {
  let clock: FakeClock;
  let originalSetTimeout: typeof globalThis.setTimeout;
  let originalClearTimeout: typeof globalThis.clearTimeout;
  let originalSetInterval: typeof globalThis.setInterval;
  let originalClearInterval: typeof globalThis.clearInterval;

  beforeEach(() => {
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    originalSetInterval = globalThis.setInterval;
    originalClearInterval = globalThis.clearInterval;
    clock = new FakeClock();
    globalThis.setTimeout = clock.setTimeout;
    globalThis.clearTimeout = clock.clearTimeout;
    globalThis.setInterval = clock.setInterval;
    globalThis.clearInterval = clock.clearInterval;
  });

  afterEach(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    setSystemTime(); // reset Date.now() to the real wall clock
  });

  // -------------------------------------------------------------------------
  // Ambient camera life (mt#3226 SC 4 — session-film aliveness pass)
  // -------------------------------------------------------------------------

  describe("PanZoomSVG — ambient drift", () => {
    test("no ambient-drift marker when the prop is omitted (the plain fit-and-hold framing)", () => {
      renderPanZoom();
      expect(screen.getByTestId("pan-zoom-svg-container").getAttribute("data-ambient-drift")).toBeNull();
    });

    test("no ambient-drift marker when explicitly disabled", () => {
      render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          ambientDrift={{ enabled: false, amplitudePx: 10, periodMs: 1000 }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      expect(screen.getByTestId("pan-zoom-svg-container").getAttribute("data-ambient-drift")).toBeNull();
    });

    test("the ambient-drift marker is present when enabled", () => {
      render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          ambientDrift={{ enabled: true, amplitudePx: 10, periodMs: 1000 }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      expect(screen.getByTestId("pan-zoom-svg-container").getAttribute("data-ambient-drift")).toBe(
        "true"
      );
    });

    test("ambient drift actually moves the viewBox over time, and STOPS once the user interacts", () => {
      render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          ambientDrift={{ enabled: true, amplitudePx: 30, periodMs: 800 }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      const container = screen.getByTestId("pan-zoom-svg-container");
      const svg = screen.getByTestId("pan-zoom-svg");
      const rect = mockRect(1280, 820);
      container.getBoundingClientRect = () => rect;
      svg.getBoundingClientRect = () => rect;

      const initialVB = svg.getAttribute("viewBox") ?? "";
      act(() => clock.advance(260));
      const driftedVB = svg.getAttribute("viewBox") ?? "";
      expect(driftedVB).not.toEqual(initialVB);

      // A user pan pauses ambience — subsequent ticks must not move the viewBox further.
      fireEvent.pointerDown(svg, { clientX: 0, clientY: 0, button: 0 });
      fireEvent.pointerUp(svg);
      const pausedVB = svg.getAttribute("viewBox") ?? "";
      act(() => clock.advance(260));
      expect(svg.getAttribute("viewBox") ?? "").toEqual(pausedVB);
    });

    test("mt#3247 R1 BLOCKING #1: ambient drift does NOT write viewBox while a growing-bounds ease is in progress", () => {
      const growingBoundsProp = {
        bounds: { minX: 500, minY: 500, maxX: 600, maxY: 600 },
        padding: 20,
        easeMs: 500,
        deadZoneMarginPx: 10,
      };

      // Ground truth: camera-follow alone (no ambient drift), partway
      // through its ease (easeMs=500, observed at 250ms — still mid-tween).
      render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          growingBounds={growingBoundsProp}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      screen.getByTestId("pan-zoom-svg-container").getBoundingClientRect = () => mockRect(1280, 820);
      screen.getByTestId("pan-zoom-svg").getBoundingClientRect = () => mockRect(1280, 820);
      act(() => clock.advance(250));
      const midEaseAlone = screen.getByTestId("pan-zoom-svg").getAttribute("viewBox") ?? "";
      cleanup();

      // Same ease, WITH ambient drift also enabled and ticking on its own
      // 200ms cadence during the same window (its first tick lands inside
      // this 250ms observation window) — if ambient drift were STILL writing
      // viewBox concurrently with the in-flight ease (the exact bug this
      // hotfix kills), this would diverge from the ground truth above by the
      // wobble's offset.
      render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          ambientDrift={{ enabled: true, amplitudePx: 50, periodMs: 300 }}
          growingBounds={growingBoundsProp}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      screen.getByTestId("pan-zoom-svg-container").getBoundingClientRect = () => mockRect(1280, 820);
      screen.getByTestId("pan-zoom-svg").getBoundingClientRect = () => mockRect(1280, 820);
      act(() => clock.advance(250));
      const midEaseWithDrift = screen.getByTestId("pan-zoom-svg").getAttribute("viewBox") ?? "";

      expect(midEaseWithDrift).toEqual(midEaseAlone);
    });

    test("ambient drift resumes once the growing-bounds ease converges and the camera is at rest", () => {
      render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          ambientDrift={{ enabled: true, amplitudePx: 40, periodMs: 300 }}
          growingBounds={{
            bounds: { minX: 500, minY: 500, maxX: 600, maxY: 600 },
            padding: 20,
            easeMs: 150,
            deadZoneMarginPx: 40,
          }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      const container = screen.getByTestId("pan-zoom-svg-container");
      const svg = screen.getByTestId("pan-zoom-svg");
      container.getBoundingClientRect = () => mockRect(1280, 820);
      svg.getBoundingClientRect = () => mockRect(1280, 820);

      // Let the ease converge (easeMs=150) and the dead zone settle — well
      // before ambient drift's own first 200ms tick even fires, and well
      // before its SECOND tick at 400ms (the margin this test relies on).
      act(() => clock.advance(390));
      const restVB = svg.getAttribute("viewBox") ?? "";

      // Camera at rest, bounds unchanged (holds the dead zone) — ambient
      // drift's own tick (due at 400ms) is now free to move the viewBox.
      act(() => clock.advance(300));
      const afterAmbientTick = svg.getAttribute("viewBox") ?? "";
      expect(afterAmbientTick).not.toEqual(restVB);
    });
  });

  // -------------------------------------------------------------------------
  // Camera-follow / growing-bounding-box auto-fit (mt#3231 SC 5)
  // -------------------------------------------------------------------------

  describe("PanZoomSVG — camera-follow auto-fit (mt#3231 SC 5 / AT 5)", () => {
    test("no growingBounds prop -> unaffected (the plain fit-and-hold framing, unchanged)", () => {
      renderPanZoom();
      expect(screen.getByTestId("pan-zoom-svg-container")).toBeDefined();
    });

    test("easeMs<=0 snaps the viewBox to fit the given bounds (the reduced-motion degrade), no ease", () => {
      render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          growingBounds={{ bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, padding: 10, easeMs: 0 }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      const container = screen.getByTestId("pan-zoom-svg-container");
      const svg = screen.getByTestId("pan-zoom-svg");
      container.getBoundingClientRect = () => mockRect(1280, 820);

      // The fit is applied on the first tick that observes a real container
      // size (see the module's "lazily resolved ease origin" comment) — the
      // override above is applied AFTER mount, matching every other test in
      // this file that patches getBoundingClientRect post-render.
      act(() => clock.advance(120));
      const vb = parseViewBox(svg.getAttribute("viewBox") ?? "");
      // The fit bounding box (0,0)-(100,100) padded by 10 on each side is
      // 120x120 world units, centered at (50,50) — width is the binding
      // constraint at this (1280x820, landscape) container aspect.
      expect(vb.w).toBeGreaterThan(0);
      expect(vb.h).toBeGreaterThan(0);
    });

    test("a non-zero easeMs eases the viewBox toward the fit over time, not an instant snap", () => {
      render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          growingBounds={{ bounds: { minX: 500, minY: 500, maxX: 600, maxY: 600 }, padding: 20, easeMs: 500 }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      const container = screen.getByTestId("pan-zoom-svg-container");
      const svg = screen.getByTestId("pan-zoom-svg");
      container.getBoundingClientRect = () => mockRect(1280, 820);
      svg.getBoundingClientRect = () => mockRect(1280, 820);

      const initialVB = svg.getAttribute("viewBox") ?? "";
      act(() => clock.advance(120));
      const midVB = svg.getAttribute("viewBox") ?? "";
      expect(midVB).not.toEqual(initialVB); // moved, but the ease hasn't necessarily finished

      act(() => clock.advance(600));
      const finalVB = parseViewBox(svg.getAttribute("viewBox") ?? "");
      // Converged near the bounds' center (550, 550).
      const cx = finalVB.x + finalVB.w / 2;
      const cy = finalVB.y + finalVB.h / 2;
      expect(cx).toBeCloseTo(550, 0);
      expect(cy).toBeCloseTo(550, 0);
    });

    test("stays put while the container is 0x0 (no fit against 0x0), then fits once real dimensions appear (mt#3231 review R1)", () => {
      render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          growingBounds={{ bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, padding: 10, easeMs: 0 }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      const container = screen.getByTestId("pan-zoom-svg-container");
      const svg = screen.getByTestId("pan-zoom-svg");

      // Container stays 0x0 (JSDOM/happy-dom default — never overridden here)
      // for a while — the zero-size backoff should keep retrying without ever
      // computing a fit against 0x0, leaving the viewBox at its initial state.
      const zeroSizeVB = svg.getAttribute("viewBox") ?? "";
      act(() => clock.advance(300));
      expect(svg.getAttribute("viewBox") ?? "").toEqual(zeroSizeVB);

      // Real dimensions appear — the next backoff-scheduled retry should pick
      // them up and compute the fit (skip/retry until real dimensions, not a
      // permanent stall).
      container.getBoundingClientRect = () => mockRect(1280, 820);
      act(() => clock.advance(400));
      const vb = parseViewBox(svg.getAttribute("viewBox") ?? "");
      expect(vb.w).toBeGreaterThan(0);
      expect(vb.w).toBeLessThan(1280); // fit to the small bounds, not the full board
    });

    test("a user pan overrides and pauses camera-follow, matching the existing ambient-drift override", () => {
      render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          growingBounds={{ bounds: { minX: 500, minY: 500, maxX: 600, maxY: 600 }, padding: 20, easeMs: 500 }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      const container = screen.getByTestId("pan-zoom-svg-container");
      const svg = screen.getByTestId("pan-zoom-svg");
      container.getBoundingClientRect = () => mockRect(1280, 820);
      svg.getBoundingClientRect = () => mockRect(1280, 820);

      // Interrupt the ease immediately with a user pan.
      fireEvent.pointerDown(svg, { clientX: 300, clientY: 300, button: 0 });
      fireEvent.pointerMove(svg, { clientX: 250, clientY: 250 });
      fireEvent.pointerUp(svg);
      const pausedVB = svg.getAttribute("viewBox") ?? "";

      act(() => clock.advance(600));
      // The camera-follow ease must NOT have continued moving the viewBox
      // toward the bounds fit after the user took control.
      expect(svg.getAttribute("viewBox") ?? "").toEqual(pausedVB);
    });
  });

  // -------------------------------------------------------------------------
  // Camera dead-zone (mt#3247 hotfix — v1.2 regression, SC1/SC2/AT1/AT3)
  //
  // The bug: v1.2 restarted the ease toward a NEW fit on every bounds change.
  // The live d3-force sim + scroll-driven touched-set changes move `bounds`
  // almost every frame in the real film, so the camera never converged —
  // continuous jump/flicker. The fix holds the camera still while bounds
  // stays within the last committed fit's viewBox plus `deadZoneMarginPx`,
  // only re-fitting when bounds would clip past that margin.
  // -------------------------------------------------------------------------

  describe("PanZoomSVG — camera dead-zone (mt#3247 hotfix)", () => {
    test("AT1: per-frame bounds churn within the margin holds the camera still (no chase)", () => {
      const { rerender } = render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          growingBounds={{
            bounds: { minX: 500, minY: 500, maxX: 600, maxY: 600 },
            padding: 20,
            easeMs: 300,
            deadZoneMarginPx: 40,
          }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      const container = screen.getByTestId("pan-zoom-svg-container");
      const svg = screen.getByTestId("pan-zoom-svg");
      container.getBoundingClientRect = () => mockRect(1280, 820);
      svg.getBoundingClientRect = () => mockRect(1280, 820);

      // Let the initial fit converge and settle.
      act(() => clock.advance(450));
      const settledVB = svg.getAttribute("viewBox") ?? "";

      // Simulate per-frame churn (the live force sim's own jiggle): the bounds
      // drift by a couple world-units every "tick", well inside the margin.
      for (let i = 0; i < 8; i++) {
        const jitter = i % 2 === 0 ? 2 : -2;
        rerender(
          <PanZoomSVG
            boardWidth={1280}
            boardHeight={820}
            ariaLabel="Test schematic"
            growingBounds={{
              bounds: {
                minX: 500 + jitter,
                minY: 500 + jitter,
                maxX: 600 + jitter,
                maxY: 600 + jitter,
              },
              padding: 20,
              easeMs: 300,
              deadZoneMarginPx: 40,
            }}
          >
            <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
          </PanZoomSVG>
        );
        act(() => clock.advance(20));
      }
      act(() => clock.advance(200));

      // Dead zone held throughout the churn — the camera never moved.
      expect(svg.getAttribute("viewBox") ?? "").toEqual(settledVB);
    });

    test("AT1: a bounds change that clips past the margin eases exactly once to re-contain it", () => {
      const { rerender } = render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          growingBounds={{
            bounds: { minX: 500, minY: 500, maxX: 600, maxY: 600 },
            padding: 20,
            easeMs: 300,
            deadZoneMarginPx: 40,
          }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      const container = screen.getByTestId("pan-zoom-svg-container");
      const svg = screen.getByTestId("pan-zoom-svg");
      container.getBoundingClientRect = () => mockRect(1280, 820);
      svg.getBoundingClientRect = () => mockRect(1280, 820);

      act(() => clock.advance(450));
      const settledVB = svg.getAttribute("viewBox") ?? "";

      // A genuinely new region — well beyond the margin around the settled fit.
      rerender(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          growingBounds={{
            bounds: { minX: 1000, minY: 1000, maxX: 1100, maxY: 1100 },
            padding: 20,
            easeMs: 300,
            deadZoneMarginPx: 40,
          }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );

      // Mid-ease: should have moved away from the old settled fit, but not yet
      // have arrived at the new one — evidence of a smooth in-flight ease
      // rather than an instant snap or a stall. Needs more headroom than a
      // bare "some ease progress" margin: once at rest, the growing-bounds
      // effect only re-checks bounds every AT_REST_POLL_MS (150ms) — the new
      // bounds aren't even DETECTED until that next poll fires, so the
      // window must clear one full poll cycle before any movement is
      // possible at all.
      act(() => clock.advance(250));
      const midVB = svg.getAttribute("viewBox") ?? "";
      expect(midVB).not.toEqual(settledVB);

      act(() => clock.advance(500));
      const finalVB = parseViewBox(svg.getAttribute("viewBox") ?? "");
      const cx = finalVB.x + finalVB.w / 2;
      const cy = finalVB.y + finalVB.h / 2;
      // Converged near the new bounds' center (1050, 1050) — a single re-fit,
      // not a still-chasing camera.
      expect(cx).toBeCloseTo(1050, 0);
      expect(cy).toBeCloseTo(1050, 0);
    });

    test("suppressed pauses auto-fit (e.g. active scroll, mt#3247 SC2c) without permanently disabling it", () => {
      const { rerender } = render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          growingBounds={{
            bounds: { minX: 500, minY: 500, maxX: 600, maxY: 600 },
            padding: 20,
            easeMs: 200,
            deadZoneMarginPx: 40,
            suppressed: true,
          }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      const container = screen.getByTestId("pan-zoom-svg-container");
      const svg = screen.getByTestId("pan-zoom-svg");
      container.getBoundingClientRect = () => mockRect(1280, 820);
      svg.getBoundingClientRect = () => mockRect(1280, 820);

      const initialVB = svg.getAttribute("viewBox") ?? "";
      act(() => clock.advance(300));
      // Suppressed — no fit computed at all, even though bounds warrants one.
      expect(svg.getAttribute("viewBox") ?? "").toEqual(initialVB);

      // Clear suppression (the caller's scroll-idle debounce firing) — the
      // NEXT tick should re-evaluate and ease to the settled fit.
      rerender(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          growingBounds={{
            bounds: { minX: 500, minY: 500, maxX: 600, maxY: 600 },
            padding: 20,
            easeMs: 200,
            deadZoneMarginPx: 40,
            suppressed: false,
          }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      act(() => clock.advance(400));
      const finalVB = parseViewBox(svg.getAttribute("viewBox") ?? "");
      const cx = finalVB.x + finalVB.w / 2;
      const cy = finalVB.y + finalVB.h / 2;
      expect(cx).toBeCloseTo(550, 0);
      expect(cy).toBeCloseTo(550, 0);
    });

    test("AT3: reduced-motion (easeMs<=0) still respects the dead zone — in-margin churn snaps nothing extra", () => {
      const { rerender } = render(
        <PanZoomSVG
          boardWidth={1280}
          boardHeight={820}
          ariaLabel="Test schematic"
          growingBounds={{
            bounds: { minX: 500, minY: 500, maxX: 600, maxY: 600 },
            padding: 20,
            easeMs: 0,
            deadZoneMarginPx: 40,
          }}
        >
          <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
        </PanZoomSVG>
      );
      const container = screen.getByTestId("pan-zoom-svg-container");
      const svg = screen.getByTestId("pan-zoom-svg");
      container.getBoundingClientRect = () => mockRect(1280, 820);
      svg.getBoundingClientRect = () => mockRect(1280, 820);

      // First tick snaps instantly (easeMs<=0) to the initial fit.
      act(() => clock.advance(200));
      const settledVB = svg.getAttribute("viewBox") ?? "";

      // In-margin churn — the snap-instead-of-tween degrade must NOT re-fire
      // on every sub-margin jiggle.
      for (let i = 0; i < 4; i++) {
        const jitter = i % 2 === 0 ? 3 : -3;
        rerender(
          <PanZoomSVG
            boardWidth={1280}
            boardHeight={820}
            ariaLabel="Test schematic"
            growingBounds={{
              bounds: {
                minX: 500 + jitter,
                minY: 500 + jitter,
                maxX: 600 + jitter,
                maxY: 600 + jitter,
              },
              padding: 20,
              easeMs: 0,
              deadZoneMarginPx: 40,
            }}
          >
            <rect data-testid="inner-rect" x="0" y="0" width="100" height="100" />
          </PanZoomSVG>
        );
        act(() => clock.advance(20));
      }
      act(() => clock.advance(200));
      expect(svg.getAttribute("viewBox") ?? "").toEqual(settledVB);
    });
  });
});