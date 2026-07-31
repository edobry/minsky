/// <reference types="vite/client" />

/**
 * Commit this bundle was built from, injected by `vite.config.ts`'s `define`
 * (mt#3241). Distinct from `/api/health`'s `commit`, which names the DAEMON
 * process's provenance — the two are independently versioned; see `RailFooter`.
 *
 * Typed `string | undefined`, NOT `string`, deliberately. The `define` only
 * exists under a vite build: in a `bun test` render, SSR, or any other
 * non-bundled context the identifier is undeclared, and merely EVALUATING it
 * throws a `ReferenceError` (measured — see `readBundleCommit` in `Rail.tsx`).
 * Declaring it as a plain `string` would let TypeScript vouch for a value that
 * does not exist at runtime, so every read goes through `readBundleCommit`'s
 * `typeof` guard, which is safe on an undeclared identifier.
 */
declare const __BUILD_COMMIT__: string | undefined;
