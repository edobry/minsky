// Self-containment guard for the observability-baseline hooks (mt#3503).
//
// `.minsky/hooks/SPEC.md` §Self-containment: the contract module and the
// baseline hooks must be loadable with NOTHING outside the hooks directory
// present on disk — no reach into `src/` or `packages/`. This is what makes
// the baseline vendorable into a foreign project (mt#3499). The domain reach
// that used to live in `types.ts` (TERMINAL_TASK_STATUS_VALUES) broke exactly
// this: a vendored copy failed module resolution on every hook event. It now
// lives in `task-statuses.ts`, which is plant-only and deliberately NOT in
// the baseline closure.
//
// Two halves:
//   1. Static: walk the transitive import graph from the baseline roots and
//      assert every specifier is node stdlib or a relative path that stays
//      inside `.minsky/hooks/`.
//   2. Runtime: copy the closure to a temp dir with no `packages/` sibling
//      and execute each baseline hook against a synthetic payload — the
//      literal vendored-project scenario, which exits non-zero pre-fix.

/* eslint-disable custom/no-real-fs-in-tests -- this file's entire purpose is
 * exercising bun's REAL module resolution against REAL files in a bare temp
 * directory (the vendored-project scenario); an in-memory fs fake cannot
 * exercise the resolver. Same justification as canary-runner.test.ts. */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const HOOKS_DIR = dirname(new URL(import.meta.url).pathname);

const RUN_STATE_HOOK = "record-conversation-run-state.ts";
const TRANSCRIPT_INGEST_HOOK = "transcript-ingest-on-session-end.ts";

/** The vendorable observability baseline (mt#3499) plus its contract module. */
export const BASELINE_ROOTS = [RUN_STATE_HOOK, TRANSCRIPT_INGEST_HOOK, "types.ts"] as const;

/** Extract import specifiers: static `from "..."`, bare `import "..."`, dynamic `import("...")`. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const re of [
    /from\s+["']([^"']+)["']/g,
    /^import\s+["']([^"']+)["']/gm,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of source.matchAll(re)) {
      const captured = match[1];
      if (captured !== undefined) specifiers.push(captured);
    }
  }
  return specifiers;
}

/** Walk the transitive relative-import closure starting from the baseline roots. */
function resolveClosure(): { files: Set<string>; violations: string[] } {
  const files = new Set<string>();
  const violations: string[] = [];
  const queue: string[] = [...BASELINE_ROOTS];

  while (queue.length > 0) {
    const fileName = queue.pop() as string;
    if (files.has(fileName)) continue;
    files.add(fileName);

    const source = readFileSync(join(HOOKS_DIR, fileName), "utf-8");
    for (const spec of importSpecifiers(source)) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith("./")) {
        // Same-directory sibling — stays in the closure. Reject nested
        // escapes like "./../" by normalizing on the raw specifier.
        if (spec.includes("..")) {
          violations.push(`${fileName} → "${spec}" (escapes the hooks directory)`);
          continue;
        }
        const target = spec.endsWith(".ts") ? spec.slice(2) : `${spec.slice(2)}.ts`;
        queue.push(target);
        continue;
      }
      // "../..." (directory escape), bare package names, "src/...", anything else.
      violations.push(`${fileName} → "${spec}" (not node stdlib, not a same-directory import)`);
    }
  }

  return { files, violations };
}

describe("baseline hook self-containment (mt#3503)", () => {
  test("transitive import closure stays inside .minsky/hooks/ and node stdlib", () => {
    const { violations } = resolveClosure();
    expect(violations).toEqual([]);
  });

  test("the closure does NOT pull in the plant-only task-statuses module", () => {
    const { files } = resolveClosure();
    expect(files.has("task-statuses.ts")).toBe(false);
  });

  test("baseline hooks execute in a bare directory with no packages/ sibling", () => {
    const scratch = mkdtempSync(join(tmpdir(), "mt3503-vendored-"));
    try {
      const { files } = resolveClosure();
      const vendorDir = join(scratch, "hooks");
      mkdirSync(vendorDir);
      for (const fileName of files) {
        copyFileSync(join(HOOKS_DIR, fileName), join(vendorDir, fileName));
      }

      for (const hook of [RUN_STATE_HOOK, TRANSCRIPT_INGEST_HOOK]) {
        const payload = JSON.stringify({
          session_id: "mt3503-self-containment-test",
          cwd: scratch,
          hook_event_name: hook === RUN_STATE_HOOK ? "PreToolUse" : "SessionEnd",
        });
        const run = Bun.spawnSync({
          cmd: ["bun", join(vendorDir, hook)],
          stdin: Buffer.from(payload),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
          // Point any state-dir writes at the scratch dir so the test never
          // touches the real machine state.
          env: { ...process.env, MINSKY_STATE_DIR: join(scratch, "state") },
        });
        // The pre-fix failure mode was `error: Cannot find module
        // '../../packages/domain/...'` with a non-zero exit — assert both
        // halves so either regression shape fails loudly.
        expect(run.stderr.toString()).not.toContain("Cannot find module");
        expect({ hook, status: run.exitCode }).toEqual({ hook, status: 0 });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
