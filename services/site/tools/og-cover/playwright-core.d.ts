// Ambient declaration for the OPTIONAL `playwright-core` import in generate.ts
// (mt#3817).
//
// generate.ts is a maintenance tool that is not wired into the build, and it
// treats playwright-core as install-on-demand: the import is dynamic, inside a
// try/catch that prints install instructions and exits when the package is
// absent. So the package is deliberately NOT a dependency of @minsky/site, and
// `await import("playwright-core")` has no module to resolve at typecheck time.
//
// This file supplies the missing type contract rather than adding a ~10MB
// browser-driver dependency to every `bun install` for a tool nobody runs in
// CI. `chromium` is `unknown` on purpose: generate.ts already narrows it to
// `any` at the use site, and inventing a richer hand-written surface here would
// diverge from the real package the moment it IS installed.
//
// Why this file exists at all: before mt#3817 nothing typechecked
// services/site, so the unresolvable import was invisible. It stayed invisible
// in local verification too — Node resolution walks past the repo root, and a
// stray ~/node_modules/playwright-core on the author's machine satisfied it.
// Only CI, which has no such ancestor directory, surfaced the error.
declare module "playwright-core" {
  export const chromium: unknown;
}
