/**
 * Peek width-policy tests (mt#4261).
 *
 * The whole policy is pure — a stored preference, a pane count and a viewport
 * width in; a rendered width out — which is what makes it testable at all. The
 * component suite runs under happy-dom, which has no layout engine, so every
 * real box would measure 0; the same split `lib/pane-width.test.ts` already
 * uses.
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/lib/peek-width.test.ts
 */
import { describe, test, expect } from "bun:test";
import {
  DEFAULT_PEEK_WIDTH_PX,
  MAX_ASSEMBLY_VIEWPORT_FRACTION,
  MAX_PEEK_WIDTH_PX,
  MIN_PAGE_COLUMN_PX,
  MIN_PEEK_WIDTH_PX,
  defaultPeekWidth,
  peekMinWidth,
  peekWidthBounds,
  resolvePeekWidth,
} from "./peek-width";
import { paneWidthCeiling } from "./pane-width";

/** The window the principal reported mt#4123's crushed-page case from. */
const NARROW_VIEWPORT = 620;
/** The window PeekHost's own comment reasons about for the two-pane case. */
const WIDE_VIEWPORT = 1440;

describe("defaultPeekWidth — mt#4123's min(26rem, 45vw), unchanged", () => {
  test("is the full 416px wherever there is room for it", () => {
    expect(defaultPeekWidth(WIDE_VIEWPORT)).toBe(DEFAULT_PEEK_WIDTH_PX);
    // ~924px is where 45vw overtakes 26rem, so just above it the constant wins.
    expect(defaultPeekWidth(1000)).toBe(DEFAULT_PEEK_WIDTH_PX);
  });

  test("yields to 45vw on a window too narrow for it", () => {
    expect(defaultPeekWidth(NARROW_VIEWPORT)).toBe(279);
    expect(defaultPeekWidth(800)).toBe(360);
  });

  test("falls back to the constant rather than to zero on an unmeasured viewport", () => {
    // A 0px pane is indistinguishable from a broken peek; a 416px one on a first
    // frame corrects itself on the next.
    expect(defaultPeekWidth(0)).toBe(DEFAULT_PEEK_WIDTH_PX);
    expect(defaultPeekWidth(Number.NaN)).toBe(DEFAULT_PEEK_WIDTH_PX);
  });
});

describe("peekMinWidth — the floor never exceeds the responsive default", () => {
  test("is the static floor on any ordinary window", () => {
    expect(peekMinWidth(WIDE_VIEWPORT)).toBe(MIN_PEEK_WIDTH_PX);
    expect(peekMinWidth(NARROW_VIEWPORT)).toBe(279);
  });

  test("yields to the default on a window narrower than the floor itself", () => {
    // Without this, `pane-width.ts`'s documented "min wins" precedence would
    // render 280px where mt#4123 renders 225 — a peek taking MORE of a small
    // window than before this task, which is the direction that task exists to
    // prevent.
    expect(peekMinWidth(500)).toBe(225);
    expect(defaultPeekWidth(500)).toBe(225);
  });
});

describe("resolvePeekWidth — with no preference, today's behavior is preserved", () => {
  test("renders the responsive default at one pane", () => {
    expect(resolvePeekWidth(null, 1, WIDE_VIEWPORT)).toBe(DEFAULT_PEEK_WIDTH_PX);
    expect(resolvePeekWidth(null, 1, NARROW_VIEWPORT)).toBe(279);
  });

  test("leaves the two-pane case at 1440 exactly as it ships", () => {
    // PeekHost's comment defends 832 of 1440 as leaving the page usable, so the
    // assembly ceiling must not bite here — this is the regression guard for it.
    expect(resolvePeekWidth(null, 2, WIDE_VIEWPORT)).toBe(DEFAULT_PEEK_WIDTH_PX);
    const ceiling = paneWidthCeiling(peekWidthBounds(2, WIDE_VIEWPORT));
    expect(ceiling).toBeGreaterThan(DEFAULT_PEEK_WIDTH_PX);
  });

  test("narrows two held panes that would otherwise take 90% of a small window", () => {
    // The deliberate behavior change: the per-pane default knows nothing about
    // how many panes are open, so 2 x 360 covers 720 of an 800px window today.
    expect(defaultPeekWidth(800) * 2).toBe(720);
    expect(resolvePeekWidth(null, 2, 800)).toBe(280);
  });
});

describe("resolvePeekWidth — a preference is honored, then bounded", () => {
  test("renders what the operator set when it fits", () => {
    expect(resolvePeekWidth(600, 1, WIDE_VIEWPORT)).toBe(600);
  });

  test("bounds the ASSEMBLY, not the pane — the ceiling halves for two panes", () => {
    const one = resolvePeekWidth(MAX_PEEK_WIDTH_PX, 1, WIDE_VIEWPORT);
    const two = resolvePeekWidth(MAX_PEEK_WIDTH_PX, 2, WIDE_VIEWPORT);

    expect(one).toBe(MAX_PEEK_WIDTH_PX);
    expect(two).toBe(446);
    // The point of the whole clamp: whatever the pane count, the assembly leaves
    // the page a majority column.
    expect(two * 2).toBeLessThan(WIDE_VIEWPORT * 0.63);
  });

  test("does not let a wide-monitor preference crush a narrow window", () => {
    // The preference is not rewritten — only what renders is bounded — so the
    // same stored 720 comes back at full width when the window grows again.
    // 320 is the page-column reserve binding (620 - 300), not the fraction,
    // which would have permitted 384 and left the page unreadable.
    expect(resolvePeekWidth(720, 1, NARROW_VIEWPORT)).toBe(NARROW_VIEWPORT - MIN_PAGE_COLUMN_PX);
    expect(resolvePeekWidth(720, 1, WIDE_VIEWPORT)).toBe(720);
  });

  test("holds the floor against a preference narrower than a legible column", () => {
    expect(resolvePeekWidth(MIN_PEEK_WIDTH_PX - 100, 1, WIDE_VIEWPORT)).toBe(MIN_PEEK_WIDTH_PX);
  });

  test("reserves an absolute page column, not just a fraction of the window", () => {
    // Found by the live check, not by reasoning: at 620px the 0.62 fraction alone
    // permits 384px and leaves the page 236px — the sliced-mid-word state mt#4123
    // was filed for, reached by the operator's own drag instead of by a constant.
    const rendered = resolvePeekWidth(MAX_PEEK_WIDTH_PX, 1, NARROW_VIEWPORT);
    expect(NARROW_VIEWPORT - rendered).toBeGreaterThanOrEqual(MIN_PAGE_COLUMN_PX);

    // A fraction is not a substitute: it scales with the window, so on a small
    // one it permits a page column that is proportionally fine and absolutely
    // unreadable. This is the assertion that would have caught it.
    expect(NARROW_VIEWPORT * MAX_ASSEMBLY_VIEWPORT_FRACTION).toBeGreaterThan(
      NARROW_VIEWPORT - MIN_PAGE_COLUMN_PX
    );
  });

  test("keeps the reserve across the whole assembly when panes are held", () => {
    const each = resolvePeekWidth(MAX_PEEK_WIDTH_PX, 2, WIDE_VIEWPORT);
    expect(WIDE_VIEWPORT - each * 2).toBeGreaterThanOrEqual(MIN_PAGE_COLUMN_PX);
  });

  test("does not let the reserve bite a window with room to spare", () => {
    // The wide single-pane case must still reach the static max — a reserve that
    // clamped everywhere would be a regression dressed as a safety bound.
    expect(resolvePeekWidth(MAX_PEEK_WIDTH_PX, 1, WIDE_VIEWPORT)).toBe(MAX_PEEK_WIDTH_PX);
  });
});

describe("peekWidthBounds — degenerate inputs", () => {
  test("treats an empty assembly as a single pane rather than dividing by zero", () => {
    // Asserted against the constant rather than by comparing the two calls:
    // `maxFraction` is optional on the shared bounds type, so an equality
    // between two of them would also hold if both were `undefined`.
    expect(peekWidthBounds(0, WIDE_VIEWPORT).maxFraction).toBe(MAX_ASSEMBLY_VIEWPORT_FRACTION);
    expect(peekWidthBounds(1, WIDE_VIEWPORT).maxFraction).toBe(MAX_ASSEMBLY_VIEWPORT_FRACTION);
    expect(peekWidthBounds(2, WIDE_VIEWPORT).maxFraction).toBe(MAX_ASSEMBLY_VIEWPORT_FRACTION / 2);
  });

  test("disables the fraction bound on an unmeasured viewport", () => {
    // `containerWidth: 0` is `pane-width.ts`'s documented "not measured yet",
    // which must not clamp a first frame to nothing.
    expect(peekWidthBounds(2, 0).containerWidth).toBe(0);
    expect(paneWidthCeiling(peekWidthBounds(2, 0))).toBe(MAX_PEEK_WIDTH_PX);
  });
});
