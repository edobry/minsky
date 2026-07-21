import { describe, test, expect } from "bun:test";
import { createMockFilesystem } from "../../src/utils/test-utils/filesystem/mock-filesystem";
import {
  runFastRelatedTestGate,
  RELATED_TEST_CAP,
  toBunTestPath,
} from "../../scripts/run-related-tests";
import type { FsLike } from "../../scripts/find-related-tests";

// mt#2932: these tests exercise the ORCHESTRATION logic (related-test lookup
// -> cap check -> mcp-isolation split -> evaluateBunTestSummary gating) with
// an injected `runBunTest` (no real `bun test` subprocess spawned) AND an
// injected in-memory mock filesystem (no real disk I/O) -- mirrors how
// tests/scripts/run-tests-gated.test.ts tests evaluateBunTestSummary directly
// rather than shelling out. The fail-closed gate itself (what counts as
// "passed") is REUSED from scripts/run-tests-gated.ts, not reimplemented here
// -- these tests confirm this script actually calls that shared gate.

const repoRoot = "/repo";

const ranLine = (n: number, files: number) =>
  `Ran ${n} tests across ${files} file${files === 1 ? "" : "s"}. [1.00s]`;

function buildFixtureFs() {
  return createMockFilesystem({
    [`${repoRoot}/src/foo.ts`]: "export const foo = 1;\n",
    [`${repoRoot}/src/foo.test.ts`]: 'import { foo } from "./foo";\ntest("foo", () => foo);\n',
    [`${repoRoot}/src/untested.ts`]: "export const untested = 1;\n",
    [`${repoRoot}/src/mcp/server.ts`]: "export const server = 1;\n",
    [`${repoRoot}/src/mcp/server.test.ts`]:
      'import { server } from "./server";\ntest("server", () => server);\n',
    [`${repoRoot}/.minsky/hooks/guard.ts`]: "export const guard = 1;\n",
    [`${repoRoot}/.minsky/hooks/guard.test.ts`]:
      'import { guard } from "./guard";\ntest("guard", () => guard);\n',
    [`${repoRoot}/src/cockpit/web/widgets/Widget.tsx`]: "export const Widget = 1;\n",
    [`${repoRoot}/src/cockpit/web/widgets/Widget.test.tsx`]:
      'import { Widget } from "./Widget";\ntest("Widget", () => Widget);\n',
  });
}

describe("runFastRelatedTestGate (mt#2932)", () => {
  test("no related tests -> ok:true, nothing run, zero related count", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = runFastRelatedTestGate(["src/untested.ts"], repoRoot, {
      fs,
      runBunTest: () => {
        throw new Error("should not be called -- there are no related tests to run");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.relatedCount).toBe(0);
    expect(result.reason).toContain("nothing to run locally");
  });

  test("a passing related test set is reported ok:true via evaluateBunTestSummary reuse", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: (files) => ({
        exitCode: 0,
        combined: [" 1 pass", " 0 fail", ranLine(1, files.length)].join("\n"),
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.relatedCount).toBe(1);
  });

  test("a failing related test set is reported ok:false with the failure reason surfaced", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: (files) => ({
        exitCode: 1,
        combined: [" 0 pass", " 1 fail", ranLine(1, files.length)].join("\n"),
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("FAILED (fail-closed)");
    expect(result.reason).toContain("1 failing test(s)");
  });

  test("a truncated related-test run (no completion summary) FAILS the gate -- fail-closed", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: () => ({
        exitCode: 0, // silent truncation: bun exits 0 with no summary
        combined: "bun test v1.2.21\n(pass) foo > does a thing [0.5ms]",
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no completion summary");
  });

  test("a related test under src/mcp/ runs isolated (its own runBunTest invocation, single file)", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const calls: string[][] = [];
    const result = runFastRelatedTestGate(["src/mcp/server.ts"], repoRoot, {
      fs,
      runBunTest: (files) => {
        calls.push(files);
        return { exitCode: 0, combined: [" 1 pass", " 0 fail", ranLine(1, 1)].join("\n") };
      },
    });
    expect(result.ok).toBe(true);
    // Updated expectation: paths handed to bun test now carry the "./" prefix
    // (toBunTestPath) so bun treats them as paths, not name filters.
    expect(calls).toEqual([["./src/mcp/server.test.ts"]]);
  });

  test("a related test under src/cockpit/web/ runs with the dom-setup preload (mt#2967)", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const calls: Array<{ files: string[]; preload?: string }> = [];
    const result = runFastRelatedTestGate(["src/cockpit/web/widgets/Widget.tsx"], repoRoot, {
      fs,
      runBunTest: (files, preload) => {
        calls.push({ files, preload });
        return { exitCode: 0, combined: [" 1 pass", " 0 fail", ranLine(1, 1)].join("\n") };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { files: ["./src/cockpit/web/widgets/Widget.test.tsx"], preload: "./tests/dom-setup.ts" },
    ]);
  });

  test("exceeding RELATED_TEST_CAP skips the local run instead of running everything", () => {
    const files: Record<string, string> = {};
    const many: string[] = [];
    for (let i = 0; i < RELATED_TEST_CAP + 5; i++) {
      const base = `capfile${i}`;
      files[`${repoRoot}/src/${base}.ts`] = `export const ${base} = ${i};\n`;
      files[`${repoRoot}/src/${base}.test.ts`] =
        `import { ${base} } from "./${base}";\ntest("${base}", () => ${base});\n`;
      many.push(`src/${base}.ts`);
    }
    const fs = createMockFilesystem(files) as unknown as FsLike;

    const result = runFastRelatedTestGate(many, repoRoot, {
      fs,
      runBunTest: () => {
        throw new Error("should not be called -- cap should skip the local run");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.relatedCount).toBeGreaterThan(RELATED_TEST_CAP);
    expect(result.reason).toContain("exceeds the fast-gate cap");
  });

  // Bun path-vs-filter quirk: a bare dot-directory path (".minsky/...") is a
  // NAME filter to bun test, matching nothing -> no completion summary ->
  // fail-closed failure on a fully passing change. First live hit: the
  // mt#2446 commit (related tests under .minsky/hooks/).
  test("dot-directory related tests are passed as ./-prefixed paths to the runner", () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const calls: string[][] = [];
    const result = runFastRelatedTestGate([".minsky/hooks/guard.ts"], repoRoot, {
      fs,
      runBunTest: (files) => {
        calls.push(files);
        return {
          exitCode: 0,
          combined: [" 1 pass", " 0 fail", ranLine(1, files.length)].join("\n"),
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([["./.minsky/hooks/guard.test.ts"]]);
  });
});

describe("toBunTestPath (mt#2446 dot-directory fix)", () => {
  const ANCHORED_FOO = "./src/foo.test.ts";
  const ANCHORED_GUARD = "./.minsky/hooks/guard.test.ts";

  test("prefixes bare repo-relative paths", () => {
    expect(toBunTestPath("src/foo.test.ts")).toBe(ANCHORED_FOO);
    expect(toBunTestPath(".minsky/hooks/guard.test.ts")).toBe(ANCHORED_GUARD);
  });

  test("leaves already-anchored paths unchanged", () => {
    expect(toBunTestPath(ANCHORED_FOO)).toBe(ANCHORED_FOO);
    expect(toBunTestPath("/abs/path/foo.test.ts")).toBe("/abs/path/foo.test.ts");
  });

  test("leaves parent-relative ../ paths unchanged (PR #2135 R1) — but a bare dot-directory still gets prefixed", () => {
    expect(toBunTestPath("../outside/foo.test.ts")).toBe("../outside/foo.test.ts");
    expect(toBunTestPath(".minsky/hooks/guard.test.ts")).toBe(ANCHORED_GUARD);
  });
});
