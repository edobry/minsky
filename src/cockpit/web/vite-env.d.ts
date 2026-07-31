/// <reference types="vite/client" />

/**
 * Commit this bundle was built from, injected by `vite.config.ts`'s `define`
 * (mt#3241). `"unknown"` when the build had no git available — a Docker build or
 * a non-git checkout.
 *
 * Distinct from `/api/health`'s `commit`, which names the DAEMON process's
 * provenance. The two are independently versioned; see `RailFooter`.
 */
declare const __BUILD_COMMIT__: string;
