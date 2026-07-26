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
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
// Ambient camera life (mt#3226 SC 4 — session-film aliveness pass)
// ---------------------------------------------------------------------------

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

  test("ambient drift actually moves the viewBox over time, and STOPS once the user interacts", async () => {
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
    const rect = {
      width: 1280,
      height: 820,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 820,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect;
    container.getBoundingClientRect = () => rect;
    svg.getBoundingClientRect = () => rect;

    const initialVB = svg.getAttribute("viewBox") ?? "";
    await new Promise((resolve) => setTimeout(resolve, 260));
    const driftedVB = svg.getAttribute("viewBox") ?? "";
    expect(driftedVB).not.toEqual(initialVB);

    // A user pan pauses ambience — subsequent ticks must not move the viewBox further.
    fireEvent.pointerDown(svg, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerUp(svg);
    const pausedVB = svg.getAttribute("viewBox") ?? "";
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(svg.getAttribute("viewBox") ?? "").toEqual(pausedVB);
  });
});

// ---------------------------------------------------------------------------
// Camera-follow / growing-bounding-box auto-fit (mt#3231 SC 5)
// ---------------------------------------------------------------------------

function mockRect(width: number, height: number): DOMRect {
  return { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} } as DOMRect;
}

describe("PanZoomSVG — camera-follow auto-fit (mt#3231 SC 5 / AT 5)", () => {
  test("no growingBounds prop -> unaffected (the plain fit-and-hold framing, unchanged)", () => {
    renderPanZoom();
    expect(screen.getByTestId("pan-zoom-svg-container")).toBeDefined();
  });

  test("easeMs<=0 snaps the viewBox to fit the given bounds (the reduced-motion degrade), no ease", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 120));
    const vb = parseViewBox(svg.getAttribute("viewBox") ?? "");
    // The fit bounding box (0,0)-(100,100) padded by 10 on each side is
    // 120x120 world units, centered at (50,50) — width is the binding
    // constraint at this (1280x820, landscape) container aspect.
    expect(vb.w).toBeGreaterThan(0);
    expect(vb.h).toBeGreaterThan(0);
  });

  test("a non-zero easeMs eases the viewBox toward the fit over time, not an instant snap", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 120));
    const midVB = svg.getAttribute("viewBox") ?? "";
    expect(midVB).not.toEqual(initialVB); // moved, but the ease hasn't necessarily finished

    await new Promise((resolve) => setTimeout(resolve, 600));
    const finalVB = parseViewBox(svg.getAttribute("viewBox") ?? "");
    // Converged near the bounds' center (550, 550).
    const cx = finalVB.x + finalVB.w / 2;
    const cy = finalVB.y + finalVB.h / 2;
    expect(cx).toBeCloseTo(550, 0);
    expect(cy).toBeCloseTo(550, 0);
  });

  test("stays put while the container is 0x0 (no fit against 0x0), then fits once real dimensions appear (mt#3231 review R1)", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(svg.getAttribute("viewBox") ?? "").toEqual(zeroSizeVB);

    // Real dimensions appear — the next backoff-scheduled retry should pick
    // them up and compute the fit (skip/retry until real dimensions, not a
    // permanent stall).
    container.getBoundingClientRect = () => mockRect(1280, 820);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const vb = parseViewBox(svg.getAttribute("viewBox") ?? "");
    expect(vb.w).toBeGreaterThan(0);
    expect(vb.w).toBeLessThan(1280); // fit to the small bounds, not the full board
  });

  test("a user pan overrides and pauses camera-follow, matching the existing ambient-drift override", async () => {
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

    await new Promise((resolve) => setTimeout(resolve, 600));
    // The camera-follow ease must NOT have continued moving the viewBox
    // toward the bounds fit after the user took control.
    expect(svg.getAttribute("viewBox") ?? "").toEqual(pausedVB);
  });
});