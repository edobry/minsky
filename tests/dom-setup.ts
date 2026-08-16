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
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { installReactRenderErrorCapture } from "./react-render-error-capture";

GlobalRegistrator.register();

// mt#4130: make a React render throw visible. Without this, React 18's
// unmount-the-root response plus tests/setup.ts's silent console mock turn a
// thrown TypeError into a blank container and a missing-element assertion —
// indistinguishable from "the data never arrived". Registered here rather than
// in tests/setup.ts because that file is a GLOBAL preload; this one is loaded
// only by `test:components`, which is the population that renders React.
installReactRenderErrorCapture();
