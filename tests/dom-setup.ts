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

GlobalRegistrator.register();
