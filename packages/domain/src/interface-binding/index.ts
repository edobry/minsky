/**
 * Interface-binding domain module (mt#1628 — iTerm-tab binding v0).
 * Barrel export, matching the existing per-submodule index.ts convention
 * used by sibling domain modules (e.g. `../session/index.ts`, `../presence/index.ts`).
 */
export type { SessionSurfaceKind, InterfaceBinding } from "./types";
export { SESSION_SURFACE_KINDS } from "./types";
export { isLocalItermCorrelationSupported } from "./deployment-mode";
export {
  listLiveItermSessionIds,
  classifyAttachment,
  runItermCorrelationPass,
  type ItermEnumerationResult,
  type CorrelatorSessionProvider,
  type RunItermCorrelationPassDeps,
  type RunItermCorrelationPassResult,
} from "./iterm-correlator";
export { resolveInterfaceBinding } from "./read";
