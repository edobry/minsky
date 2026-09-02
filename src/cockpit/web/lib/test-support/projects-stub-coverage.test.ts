/**
 * Guard: every cockpit component test that mounts `ProjectProvider` must also
 * stub `/api/projects` (mt#4842).
 *
 * Without the stub the provider's own query 404s on mount, the whole tree
 * renders with project context in an ERROR state, and assertions written
 * against the resulting empty-list branch pass. Nothing goes red — which is
 * precisely why this needs a guard rather than trust: the failure mode of the
 * defect is silence, so the failure mode of forgetting the fix is also silence.
 *
 * This runs in CI via `bun run test:components` (`.github/workflows/ci.yml`),
 * which overrides `bunfig.toml`'s `src/cockpit/web/**` exclusion. It does NOT
 * run under the default gated suite, and that is a property of where cockpit
 * tests live, not of this file.
 */
import { describe, expect, test } from "bun:test";
// A source census must read the actual tree; there is nothing to inject. Same
// shape and same justification as `lib/liveness-colors.test.ts`, which reads
// `index.css` to pin CSS/TS agreement. The directive has to sit on the line
// immediately above the import — on a comment continuation it is inert, and
// reports itself as an unused directive rather than covering anything.
// eslint-disable-next-line custom/no-real-fs-in-tests
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

const WEB_ROOT = join(import.meta.dir, "..", "..");

/** Every `*.test.tsx` under the cockpit web tree. */
function componentTestFiles(dir: string, found: string[] = []): string[] {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- see file header
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // `dist/` is build output, not source; `test:components` excludes it too.
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      componentTestFiles(full, found);
    } else if (entry.name.endsWith(".test.tsx")) {
      found.push(full);
    }
  }
  return found;
}

describe("mt#4842 — every ProjectProvider test stubs /api/projects", () => {
  test("no cockpit component test mounts the provider with the endpoint unstubbed", () => {
    const offenders: string[] = [];

    for (const file of componentTestFiles(WEB_ROOT)) {
      // eslint-disable-next-line custom/no-real-fs-in-tests -- see file header
      const source = readFileSync(file, "utf-8");
      if (!source.includes("ProjectProvider")) continue;

      // Either the shared installer, or a hand-rolled route branch. Both leave
      // the provider's query resolvable; the guard is about the OUTCOME, not
      // about forcing every file through one helper.
      const stubbed = source.includes("stubProjectsRoute") || source.includes("/api/projects");
      if (!stubbed) offenders.push(relative(WEB_ROOT, file));
    }

    expect(offenders).toEqual([]);
  });

  test("the census actually finds files — a zero-file walk would pass vacuously", () => {
    // Without this, a broken walk (wrong root, changed extension) makes the
    // check above pass by finding nothing, which is the failure mode the
    // defect this guards against already demonstrated once.
    const files = componentTestFiles(WEB_ROOT);
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.includes("ProjectProvider") === false)).toBe(true);
  });
});
