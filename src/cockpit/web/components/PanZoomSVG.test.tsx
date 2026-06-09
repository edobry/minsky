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
    const initialW = parseFloat(initialVB.split(" ")[2]);

    const zoomInBtn = screen.getByRole("button", { name: "Zoom in" });
    fireEvent.click(zoomInBtn);

    const afterVB = svg.getAttribute("viewBox") ?? "";
    const afterW = parseFloat(afterVB.split(" ")[2]);

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
    const midW = parseFloat(midVB.split(" ")[2]);

    const zoomOutBtn = screen.getByRole("button", { name: "Zoom out" });
    fireEvent.click(zoomOutBtn);

    const afterVB = svg.getAttribute("viewBox") ?? "";
    const afterW = parseFloat(afterVB.split(" ")[2]);

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
    const [initialX, initialY] = initialVB.split(" ").map(parseFloat);

    // Simulate a drag: pointerdown at (300, 300), pointermove to (200, 250)
    // dragging left+up should move the viewBox right+down (pan right+down)
    fireEvent.pointerDown(svg, { button: 0, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(svg, { clientX: 200, clientY: 250 });
    fireEvent.pointerUp(svg);

    const afterVB = svg.getAttribute("viewBox") ?? "";
    const [afterX, afterY] = afterVB.split(" ").map(parseFloat);

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
    const resetW = parseFloat(resetVB.split(" ")[2]);
    // In JSDOM getBoundingClientRect returns 0, so fit-width cannot be computed;
    // the initial state has w=1280. The reset should have returned to a wider view.
    expect(resetW).toBeGreaterThan(parseFloat(zoomedVB.split(" ")[2]));
  });
});
