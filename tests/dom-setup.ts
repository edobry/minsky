/**
 * DOM test preload (mt#2152)
 *
 * Registers happy-dom globals (window, document, etc.) for React component
 * testing with @testing-library/react. This file MUST be loaded as a separate
 * preload BEFORE the main tests/setup.ts so that DOM globals are available
 * when @testing-library/react is imported.
 *
 * NOT added to bunfig.toml's global preload — only used via the
 * `test:components` script or explicit `--preload ./tests/dom-setup.ts`.
 * This keeps server-side tests unaffected by DOM globals.
 */
import { beforeEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { installReactRenderErrorCapture } from "./react-render-error-capture";

GlobalRegistrator.register();

// mt#4801: reset the URL between tests.
//
// `useListControls` (src/cockpit/web/lib/useListControls.ts) persists page,
// sort and filter state in the query string — read at mount via
// `useState(() => window.location.search)` and written via
// `window.history.replaceState`. It does that DELIBERATELY and without a
// router, so `MemoryRouter` does not isolate it: `window.location` is one
// object per bun process, shared by every test and every test FILE in a
// `test:components` run.
//
// Nothing reset it, so query params ACCUMULATED across the whole suite. Every
// consumer contributes under its own prefix — ChangesetsPage, MemoriesPage,
// AsksPage, Workstreams, MemoriesList, Agents, TaskList — and a later test
// mounts already filtered by an earlier one's selection.
//
// Measured at the head of `ChangesetsPage.test.tsx`'s 'last 7d' test:
//
//   isolation:  search=""
//   full suite: search="?mem_f_untagged=true&changesets_f_age=24h"
//
// `changesets_f_age=24h` leaked from the preceding test in the SAME file;
// `mem_f_untagged=true` from a different file entirely. The page therefore
// mounted with the 24h filter applied and rendered "2 active", so that test's
// `waitFor(/3 active/)` could never match — it failed at a 1s budget and still
// failed at 15s, because nothing was ever going to settle.
//
// Why it passed in isolation, which is what made it look like a load-sensitive
// flake: an isolated run is fast (716ms for 17 tests) and the `replaceState`
// effect had not flushed before teardown, so the URL stayed clean. Under full
// suite load it flushes and persists. That timing dependence is the race — the
// budget was never the problem, and raising it would have fixed nothing.
//
// Registered here rather than in each test file for the same reason the
// mt#4130 capture above is: this preload is loaded by exactly the population
// that renders React and mutates the URL, and a per-file fix leaves every
// other consumer still leaking into the shared object.
beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

// mt#4130: make a React render throw visible. Without this, React 18's
// unmount-the-root response plus tests/setup.ts's silent console mock turn a
// thrown TypeError into a blank container and a missing-element assertion —
// indistinguishable from "the data never arrived". Registered here rather than
// in tests/setup.ts because that file is a GLOBAL preload; this one is loaded
// only by `test:components`, which is the population that renders React.
installReactRenderErrorCapture();
