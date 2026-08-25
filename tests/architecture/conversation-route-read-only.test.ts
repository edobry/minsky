/**
 * The unified conversation route is read-only, and this asserts it STRUCTURALLY (mt#4488).
 *
 * `ConversationPage` must never open a session-driver channel. That guarantee used to be
 * asserted from inside `ConversationPage.unified.test.tsx` by replacing
 * `globalThis.WebSocket` with a recorder and checking nothing matching `driven-session` was
 * constructed — the patched-collaborator shape `testing-standards.mdc §Testable Design`
 * names, and which ADR-036 §1 ranks last of three mechanisms.
 *
 * Two reasons the check moved here rather than being re-plumbed as an injected double:
 *
 * 1. **There is nothing to inject.** `ConversationPage` does not open a socket, does not
 *    import `useDrivenSession`, and does not mention `WebSocket`. The only `new WebSocket`
 *    in cockpit-web is `hooks/useDrivenSession.ts`, whose callers are `DrivenSessionPage`
 *    and `AgentDrivenPeek`. A `deps`-injected socket factory would have been a seam for a
 *    call that does not exist.
 * 2. **The static claim is STRICTLY STRONGER.** The recorder proved "no channel opened in
 *    the states this one test happened to render." This proves no code path can open one,
 *    in any state, because the module is not reachable from the route's import closure at
 *    all. A rendering branch the component test never exercised could always have defeated
 *    the runtime form; it cannot defeat this one.
 *
 * This is SC1's third option — "a route composition that structurally cannot open one" —
 * and it touches ZERO production files, which is inside ADR-036 rule 2's budget rather
 * than merely at it.
 *
 * **Type-only imports are deliberately NOT edges.** `import type { DrivenSessionStatus }`
 * is erased at compile time and opens nothing; counting it would fail this test for a
 * component that merely names the status union (`DrivenSessionStatusBar.tsx:13` does
 * exactly that). The regex below therefore skips `import type` / `export type` forms.
 *
 * @see docs/architecture/adr-036-testing-doubles-mechanism-and-patching-ban.md
 * @see src/cockpit/web/pages/ConversationPage.unified.test.tsx — the behavioural suite this
 *      guarantee was lifted out of
 */
import { describe, expect, test } from "bun:test";
/* eslint-disable custom/no-real-fs-in-tests -- reads the real committed sources: which
   modules a route's import closure reaches is a property of the committed FILES, not of
   injectable state, so there is nothing to inject. Same exemption shape as
   tests/architecture/scrub-gate-boundary.test.ts. Scoped to the two helpers below rather
   than the whole file — every other line here is pure. */
import { existsSync, readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";

const REPO_ROOT = join(import.meta.dir, "../..");

/**
 * Read a repo-relative source, or null when it does not exist.
 *
 * The `as string` matches the three sibling architecture tests: Bun's stricter
 * `readFileSync` overload typing widens the utf8 return to `string | Buffer`, so the cast
 * narrows rather than asserts anything unchecked (see
 * `tests/architecture/bundle-reflect-polyfill.test.ts:39`).
 */
function readSource(repoRelPath: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, repoRelPath), "utf8") as string;
  } catch {
    return null;
  }
}

/** Does a repo-relative path exist on disk? */
function pathExists(repoRelAbs: string): boolean {
  return existsSync(repoRelAbs);
}
/* eslint-enable custom/no-real-fs-in-tests */

const ROUTE_ENTRY = "src/cockpit/web/pages/ConversationPage.tsx";
/** The one module in cockpit-web that constructs a driven-session WebSocket. */
const DRIVER_CHANNEL = "src/cockpit/web/hooks/useDrivenSession.ts";

/**
 * VALUE imports only. `import type ...` / `export type ...` are erased and open nothing.
 * Captures the specifier of a relative import; bare package specifiers are ignored because
 * a node_modules edge cannot reach a first-party module.
 */
const VALUE_IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;'"]*from\s*["'](\.[^"']+)["']/g;

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Resolve a relative specifier to a repo-relative file path, or null if it resolves nowhere. */
function resolveSpecifier(fromFileRel: string, specifier: string): string | null {
  const base = resolve(REPO_ROOT, dirname(fromFileRel), specifier);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (pathExists(candidate) && !candidate.endsWith("/")) {
      const rel = relative(REPO_ROOT, candidate);
      // A directory that exists but holds no index file resolves to itself; reject it.
      if (rel.endsWith(".ts") || rel.endsWith(".tsx")) return rel;
    }
  }
  return null;
}

/** Every first-party module reachable from `entry` through VALUE imports. */
function importClosure(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const src = readSource(current);
    if (src === null) continue;
    for (const match of src.matchAll(VALUE_IMPORT_RE)) {
      const specifier = match[1];
      if (!specifier) continue;
      const resolved = resolveSpecifier(current, specifier);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return seen;
}

describe("the unified conversation route cannot open a session-driver channel (mt#4488)", () => {
  test("the walker itself works — the entry's closure is non-trivial and contains the entry", () => {
    // A closure builder that silently resolves nothing would make every assertion below
    // pass vacuously (mem#704: a filter-shaped probe defaults to empty, so the
    // discriminating control is the POSITIVE one). Establish it found real edges first.
    const closure = importClosure(ROUTE_ENTRY);
    expect(closure.has(ROUTE_ENTRY)).toBe(true);
    expect(closure.size).toBeGreaterThan(5);
  });

  test("the driver-channel module exists and is where the WebSocket is constructed", () => {
    // Pins the target: if useDrivenSession is renamed or the socket moves, this fails
    // rather than the closure assertion passing because DRIVER_CHANNEL names nothing.
    const src = readSource(DRIVER_CHANNEL);
    expect(src).not.toBeNull();
    expect(src).toContain("new WebSocket(");
  });

  test("ConversationPage's import closure does NOT reach useDrivenSession", () => {
    const closure = importClosure(ROUTE_ENTRY);
    expect(closure.has(DRIVER_CHANNEL)).toBe(false);
  });

  test("the walker CAN find the driver channel — from a route that legitimately drives", () => {
    // The negative control for the assertion above. Without this, "not reachable" is
    // consistent with a walker that reaches nothing in particular. DrivenSessionPage owns
    // a driven session by design, so its closure MUST contain the module.
    const drivingRoute = "src/cockpit/web/pages/DrivenSessionPage.tsx";
    expect(importClosure(drivingRoute).has(DRIVER_CHANNEL)).toBe(true);
  });
});
