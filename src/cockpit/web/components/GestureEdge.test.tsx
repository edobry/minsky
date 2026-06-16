/**
 * GestureEdge regression tests (mt#2377 v2.0, PR #1695 R1).
 *
 * The blocking finding: when a gesture is active AND prefers-reduced-motion is
 * on, the component builds `effectiveStyle` by spreading the edge's `style`
 * prop — which is `React.CSSProperties | undefined`. Spreading `undefined`
 * threw a runtime TypeError. These tests pin the no-style + reduced-motion
 * path so it renders the static brighten without throwing.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import { GestureEdge } from "./GestureEdge";

function mockReducedMotion(matches: boolean) {
  // @ts-expect-error - jsdom matchMedia stub
  globalThis.window.matchMedia = mock((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));
}

// GestureEdge renders <BaseEdge> (a plain <path>) + an optional <circle>;
// both are valid SVG children, so it can mount inside a bare <svg> without a
// full ReactFlow provider.
function renderEdge(props: Record<string, unknown>) {
  return render(
    <svg>
      {/* @ts-expect-error - partial EdgeProps is sufficient for these paths */}
      <GestureEdge
        id="e1"
        sourceX={0}
        sourceY={0}
        targetX={100}
        targetY={100}
        {...props}
      />
    </svg>
  );
}

afterEach(() => {
  cleanup();
});

describe("GestureEdge", () => {
  test("active gesture + reduced motion + NO style prop does not throw", () => {
    mockReducedMotion(true);
    expect(() =>
      renderEdge({
        data: { gestureUntil: Date.now() + 5_000, gestureColorVar: "var(--vsm-s1)" },
        // style intentionally omitted — the regression case
      })
    ).not.toThrow();
  });

  test("active gesture + reduced motion renders the static brighten, no moving dot", () => {
    mockReducedMotion(true);
    const { container } = renderEdge({
      data: { gestureUntil: Date.now() + 5_000, gestureColorVar: "var(--vsm-s1)" },
    });
    // Reduced motion: the traveling dot is suppressed.
    expect(container.querySelector('[data-testid="gesture-dot-e1"]')).toBeNull();
  });

  test("active gesture + full motion renders the traveling dot", () => {
    mockReducedMotion(false);
    const { container } = renderEdge({
      data: { gestureUntil: Date.now() + 5_000, gestureColorVar: "var(--vsm-s1)" },
      style: { stroke: "oklch(var(--vsm-s1) / 1)" },
    });
    expect(container.querySelector('[data-testid="gesture-dot-e1"]')).not.toBeNull();
  });

  test("no active gesture renders no dot (idle)", () => {
    mockReducedMotion(false);
    const { container } = renderEdge({ data: {} });
    expect(container.querySelector('[data-testid="gesture-dot-e1"]')).toBeNull();
  });
});
