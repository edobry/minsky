/**
 * React render-error visibility for the cockpit-web component harness (mt#4130).
 *
 * ## The failure this exists to remove
 *
 * React 18 responds to an uncaught error during render by unmounting the ENTIRE
 * root. `tests/setup.ts` replaces `console.error` with a silent mock, so React's
 * own report of that error is discarded. What a test author sees is Testing
 * Library's "Unable to find an element with the text: …" over a `<body><div />`
 * dump — the exact output a test would produce if the data had simply never
 * arrived. The two are indistinguishable, and the render throw is the one that
 * looks like someone else's bug.
 *
 * mt#4069 lost roughly two sessions to that ambiguity: four fetch-shaped
 * hypotheses were raised and falsified before anyone questioned the frame. The
 * cause was a test fixture missing five required fields, and it was found only
 * by hand-wrapping the component in a throwaway error boundary that wrote
 * `componentDidCatch` to a file with `node:fs` — because console was mocked.
 *
 * ## Why a console wrapper rather than a default error boundary
 *
 * A boundary has to be INSTALLED somewhere, and there is no shared render
 * helper to install it in: 101 cockpit-web test files import `render` directly
 * from `@testing-library/react`. Migrating all of them would still leave the
 * next hand-written `render()` silently opted out. A preload sees every test
 * without any opt-in, which is the property Success Criterion 2 asks for.
 *
 * ## Why it lives beside `dom-setup`, not in `tests/setup.ts`
 *
 * `tests/setup.ts` is a GLOBAL preload (`bunfig.toml`), loaded by every suite in
 * the repo. `tests/dom-setup.ts` is loaded only by `test:components` and by an
 * explicit `--preload`, so wiring this there scopes it to the population that
 * renders React at all.
 */
import { afterEach, beforeEach } from "bun:test";

/**
 * The sentinel React 18 prints when an error escapes render with no boundary.
 *
 * Matching React's own report rather than the raw error is deliberate: the raw
 * error reaches `console.error` from plenty of legitimate places (a component
 * logging a handled failure, a library warning), and failing on those would
 * make this mechanism the noise it exists to remove. This marker appears only
 * on the unmount-the-root path.
 */
export const REACT_UNCAUGHT_RENDER_MARKER = "The above error occurred in the";

/**
 * React's tell that a boundary HANDLED the error — the case we must NOT fail on.
 *
 * React logs the same "The above error occurred in the <X> component" report
 * whether or not a boundary catches it; only the tail differs. Uncaught ends
 * with "Consider adding an error boundary…"; caught ends with "React will try to
 * recreate this component tree using the error boundary you provided". A
 * boundary-caught throw is DESIGNED degradation — `ErrorBoundary` renders its
 * fallback, the operator sees a named crash rather than a blank pane, and the
 * app keeps working. Failing those would make this mechanism punish the very
 * pattern mt#4069 added to `PeekHost`.
 *
 * Measured: without this discriminator, three pre-existing `WorkspaceDetailPage`
 * route tests failed — each one a boundary catching correctly.
 */
export const REACT_HANDLED_BY_BOUNDARY_MARKER = "error boundary you provided";

/** Every `console.error` call made during the current test, in order. */
let captured: string[] = [];

/** Marks our wrapper so re-entrant installs don't nest it. */
const WRAPPED = Symbol.for("minsky.reactRenderErrorCapture");

/** Anything carrying a string `message`, whatever realm it was constructed in. */
function isErrorLike(value: unknown): value is { name?: string; message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      // Duck-typed rather than `instanceof Error` (PR #2987 R1): an error thrown
      // across a realm boundary, or a non-Error thrown value carrying a message,
      // fails the instanceof check and would degrade to "[object Object]" —
      // dropping exactly the text this mechanism exists to surface.
      if (isErrorLike(a)) return `${a.name ?? "Error"}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        // intentional-swallow: a value that will not serialize is still worth
        // showing as its coerced form; the diagnostic must not itself throw.
        return String(a);
      }
    })
    .join(" ");
}

/**
 * Take (and clear) the React render errors captured so far.
 *
 * A test that deliberately renders a throwing component calls this to ASSERT on
 * the error and to consume it, so the `afterEach` below does not then fail the
 * test for the throw it was testing. Consuming is the opt-out; nothing else in
 * the harness needs one.
 */
export function takeCapturedReactRenderErrors(): string[] {
  const found: string[] = [];
  for (const [i, line] of captured.entries()) {
    if (!line.includes(REACT_UNCAUGHT_RENDER_MARKER)) continue;
    if (line.includes(REACT_HANDLED_BY_BOUNDARY_MARKER)) continue;
    // React logs the raw error and this report as SEPARATE console.error calls —
    // hence "The ABOVE error occurred". Keeping only the report names the
    // component but not the failure, which is half the diagnostic and the half a
    // reader needs first. Pair each report with the line it refers to.
    const precedingError = i > 0 ? captured[i - 1] : undefined;
    found.push(precedingError ? `${precedingError}\n${line}` : line);
  }
  captured = [];
  return found;
}

/**
 * Wrap whatever `console.error` is currently installed, preserving its behavior.
 *
 * Called from `beforeEach` rather than at import time on purpose: this module is
 * imported by `tests/dom-setup.ts`, which by design runs BEFORE `tests/setup.ts`
 * installs its silent mock. Wrapping at import time would capture the real
 * console and then be overwritten a moment later. By the first `beforeEach`, the
 * mock is in place, and we wrap that — so output stays as silent as it was.
 */
function installCapture(): void {
  const current = console.error as typeof console.error & { [WRAPPED]?: true };
  if (current[WRAPPED]) return;

  const wrapper = ((...args: unknown[]) => {
    captured.push(formatArgs(args));
    (current as (...a: unknown[]) => void)(...args);
  }) as typeof console.error & { [WRAPPED]?: true };
  wrapper[WRAPPED] = true;

  console.error = wrapper;
}

/**
 * Register the per-test capture. Invoked once, from the DOM preload.
 *
 * The `afterEach` FAILS a test that produced an unconsumed React render error,
 * rather than merely printing it. A printed warning under a suite that already
 * mocks console to stay quiet is a line nobody reads; the whole defect class is
 * that the signal was present-but-invisible.
 */
export function installReactRenderErrorCapture(): void {
  beforeEach(() => {
    captured = [];
    installCapture();
  });

  afterEach(() => {
    const renderErrors = takeCapturedReactRenderErrors();
    if (renderErrors.length === 0) return;

    throw new Error(
      `A React component threw during render, so React unmounted the tree and this test saw an empty container.\n` +
        `This is NOT a missing-data failure — read the error below before suspecting the fetch path.\n\n` +
        `${renderErrors.join("\n\n")}\n\n` +
        `(If the throw is intentional, consume it with takeCapturedReactRenderErrors() from tests/react-render-error-capture.ts.)`
    );
  });
}
