import { describe, test, expect } from "bun:test";
import { createMockFilesystem } from "../../src/utils/test-utils/filesystem/mock-filesystem";
import {
  runFastRelatedTestGate,
  toBunTestPath,
  type BunTestRunResult,
} from "../../scripts/run-related-tests";
import type { FsLike } from "../../scripts/find-related-tests";

// mt#2932: these tests exercise the ORCHESTRATION logic (related-test lookup
// -> mcp-isolation split -> evaluateBunTestSummary gating) with
// an injected `runBunTest` (no real `bun test` subprocess spawned) AND an
// injected in-memory mock filesystem (no real disk I/O) -- mirrors how
// tests/scripts/run-tests-gated.test.ts tests evaluateBunTestSummary directly
// rather than shelling out. The fail-closed gate itself (what counts as
// "passed") is REUSED from scripts/run-tests-gated.ts, not reimplemented here
// -- these tests confirm this script actually calls that shared gate.

const repoRoot = "/repo";

// mt#3776 fixture: a source file whose related test lives inside a service
// workspace (the partition that must NOT run under the root cwd).
const SERVICE_SOURCE_FILE = "services/reviewer/src/alert-sink.ts";
/** Fixture source whose sibling test runs in its own isolated partition (mt#2665). */
const MCP_SOURCE_FILE = "src/mcp/server.ts";
/** Fixture source under a DOT-directory, where bun needs a `./` anchor to read the arg as a path. */
const HOOK_SOURCE_FILE = ".minsky/hooks/guard.ts";
const HOOK_TEST_FILE = ".minsky/hooks/guard.test.ts";

const ranLine = (n: number, files: number) =>
  `Ran ${n} tests across ${files} file${files === 1 ? "" : "s"}. [1.00s]`;

/**
 * mt#3765: `runBunTest` is async and returns watchdog disposition alongside the
 * output. Tests still express the interesting part synchronously — `adapt`
 * supplies the uninteresting fields so each fake states only what it is about.
 */
type SyncFake = (
  files: string[],
  preload?: string,
  ignore?: string,
  cwd?: string
) => { exitCode: number; combined: string };

const adapt =
  (fake: SyncFake) =>
  async (
    files: string[],
    preload?: string,
    ignore?: string,
    cwd?: string
  ): Promise<BunTestRunResult> => ({
    ...fake(files, preload, ignore, cwd),
    timedOut: false,
    elapsedMs: 10,
    budgetMs: 60_000,
  });

/** A fake whose partition exceeded the wall-clock watchdog (mt#3765). */
const timedOutFake = async (): Promise<BunTestRunResult> => ({
  exitCode: 1, // spawnWithWatchdog is fail-closed on exit code even when timing out
  combined: "bun test v1.3.14\n(pass) foo > partial [0.5ms]", // no completion summary
  timedOut: true,
  elapsedMs: 60_123,
  budgetMs: 60_000,
  timeoutMessage: "the related-test partition hit its 60s pre-commit wall-clock budget (ran 60s).",
});

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
    [`${repoRoot}/services/reviewer/src/alert-sink.ts`]: "export const sink = 1;\n",
    [`${repoRoot}/services/reviewer/src/alert-sink.test.ts`]:
      'import { sink } from "./alert-sink";\ntest("sink", () => sink);\n',
  });
}

describe("runFastRelatedTestGate (mt#2932)", () => {
  test("no related tests -> ok:true, nothing run, zero related count", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = await runFastRelatedTestGate(["src/untested.ts"], repoRoot, {
      fs,
      runBunTest: async () => {
        throw new Error("should not be called -- there are no related tests to run");
      },
    });
    expect(result.ok).toBe(true);
    expect(result.relatedCount).toBe(0);
    expect(result.reason).toContain("nothing to run locally");
  });

  test("a passing related test set is reported ok:true via evaluateBunTestSummary reuse", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = await runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: adapt((files) => ({
        exitCode: 0,
        combined: [" 1 pass", " 0 fail", ranLine(1, files.length)].join("\n"),
      })),
    });
    expect(result.ok).toBe(true);
    expect(result.relatedCount).toBe(1);
  });

  test("a failing related test set is reported ok:false with the failure reason surfaced", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = await runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: adapt((files) => ({
        exitCode: 1,
        combined: [" 0 pass", " 1 fail", ranLine(1, files.length)].join("\n"),
      })),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("FAILED (fail-closed)");
    expect(result.reason).toContain("1 failing test(s)");
  });

  test("a truncated related-test run (no completion summary) FAILS the gate -- fail-closed", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = await runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: adapt(() => ({
        exitCode: 0, // silent truncation: bun exits 0 with no summary
        combined: "bun test v1.2.21\n(pass) foo > does a thing [0.5ms]",
      })),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no completion summary");
  });

  test("a related test under src/mcp/ runs isolated (its own runBunTest invocation, single file)", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const calls: string[][] = [];
    const result = await runFastRelatedTestGate([MCP_SOURCE_FILE], repoRoot, {
      fs,
      runBunTest: adapt((files) => {
        calls.push(files);
        return { exitCode: 0, combined: [" 1 pass", " 0 fail", ranLine(1, 1)].join("\n") };
      }),
    });
    expect(result.ok).toBe(true);
    // Updated expectation: paths handed to bun test now carry the "./" prefix
    // (toBunTestPath) so bun treats them as paths, not name filters.
    expect(calls).toEqual([["./src/mcp/server.test.ts"]]);
  });

  test("a related test under src/cockpit/web/ runs with the dom-setup preload (mt#2967)", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const calls: Array<{ files: string[]; preload?: string }> = [];
    const result = await runFastRelatedTestGate(["src/cockpit/web/widgets/Widget.tsx"], repoRoot, {
      fs,
      runBunTest: adapt((files, preload) => {
        calls.push({ files, preload });
        return { exitCode: 0, combined: [" 1 pass", " 0 fail", ranLine(1, 1)].join("\n") };
      }),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { files: ["./src/cockpit/web/widgets/Widget.test.tsx"], preload: "./tests/dom-setup.ts" },
    ]);
  });

  test("the cockpit-web run overrides bunfig's ignore patterns so its own files are not pruned (mt#3738)", async () => {
    // Without this, bunfig.toml's `src/cockpit/web/**` entry prunes the exact
    // paths the branch just named: bun matches nothing, prints no summary, and
    // the fail-closed gate turns the silence into a blocked commit. Asserting
    // on the ARGUMENT rather than on a real run because the fixture fs has no
    // real test files to execute; the behavioral check is that a real
    // cockpit-web file now runs at all.
    const fs = buildFixtureFs() as unknown as FsLike;
    const calls: Array<{ files: string[]; preload?: string; ignore?: string }> = [];
    const result = await runFastRelatedTestGate(["src/cockpit/web/widgets/Widget.tsx"], repoRoot, {
      fs,
      runBunTest: adapt((files, preload, ignore) => {
        calls.push({ files, preload, ignore });
        return { exitCode: 0, combined: [" 1 pass", " 0 fail", ranLine(1, 1)].join("\n") };
      }),
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.ignore).toBe("services/**");
    expect(calls[0]?.ignore).not.toContain("cockpit");
  });

  test("non-cockpit runs pass no ignore-pattern override (mt#3738)", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const calls: Array<{ files: string[]; preload?: string; ignore?: string }> = [];
    const result = await runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: adapt((files, preload, ignore) => {
        calls.push({ files, preload, ignore });
        return { exitCode: 0, combined: [" 1 pass", " 0 fail", ranLine(1, 1)].join("\n") };
      }),
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.ignore).toBeUndefined();
  });

  // mt#3776: services/** tests are pruned by bunfig's pathIgnorePatterns even
  // when named explicitly on a root-cwd command line. An all-services related
  // set therefore ran zero tests, printed no summary, and fail-closed every
  // commit; in a mixed set the services subset was pruned SILENTLY while the
  // root subset's summary made the gate pass. The fix runs each service's
  // tests from that service's directory (no bunfig there), the way CI and the
  // service's own `test` script do.
  test("a related test under services/<svc>/ runs from the service directory (mt#3776)", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const calls: Array<{ files: string[]; preload?: string; ignore?: string; cwd?: string }> = [];
    const result = await runFastRelatedTestGate([SERVICE_SOURCE_FILE], repoRoot, {
      fs,
      runBunTest: adapt((files, preload, ignore, cwd) => {
        calls.push({ files, preload, ignore, cwd });
        return { exitCode: 0, combined: [" 1 pass", " 0 fail", ranLine(1, 1)].join("\n") };
      }),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        files: ["./src/alert-sink.test.ts"],
        preload: "../../tests/setup.ts",
        ignore: undefined,
        cwd: `${repoRoot}/services/reviewer`,
      },
    ]);
  });

  test("a mixed root + services set runs BOTH partitions, each with its own cwd (mt#3776)", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const calls: Array<{ files: string[]; cwd?: string }> = [];
    const result = await runFastRelatedTestGate(["src/foo.ts", SERVICE_SOURCE_FILE], repoRoot, {
      fs,
      runBunTest: adapt((files, _preload, _ignore, cwd) => {
        calls.push({ files, cwd });
        return {
          exitCode: 0,
          combined: [" 1 pass", " 0 fail", ranLine(1, files.length)].join("\n"),
        };
      }),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { files: ["./src/foo.test.ts"], cwd: undefined },
      { files: ["./src/alert-sink.test.ts"], cwd: `${repoRoot}/services/reviewer` },
    ]);
  });

  test("a failing services run fails the gate fail-closed with the service named (mt#3776)", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = await runFastRelatedTestGate([SERVICE_SOURCE_FILE], repoRoot, {
      fs,
      runBunTest: adapt(() => ({
        exitCode: 1,
        combined: [" 0 pass", " 1 fail", ranLine(1, 1)].join("\n"),
      })),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("services/reviewer");
    expect(result.reason).toContain("FAILED (fail-closed, service-directory run)");
  });

  test("a truncated services run (no completion summary) also fails the gate (mt#3776)", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = await runFastRelatedTestGate([SERVICE_SOURCE_FILE], repoRoot, {
      fs,
      runBunTest: adapt(() => ({
        exitCode: 0,
        combined: "bun test v1.2.21\n", // pruned-to-nothing shape: exit 0, no summary
      })),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no completion summary");
  });

  // ── mt#3765: wall-clock timeout is reported, not fail-closed ──────────────

  test("a TIMED-OUT partition does NOT block the commit and is reported as a timeout", async () => {
    // The behavior change this task exists for. Before mt#3765 the same input
    // (no completion summary) fail-closed, and because session_commit cannot
    // set MINSKY_SKIP_RELATED_TESTS and `git commit` is denied on both Bash and
    // session_exec, the commit could not be made at all.
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = await runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: timedOutFake,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toContain("TIMED OUT");
    expect(result.reason).toContain("NOT blocked");
    expect(result.reason).toContain("pre-push");
  });

  test("a timeout is distinguishable from a truncation -- the message never claims truncation", async () => {
    // mt#3765 SC2: both states have no completion summary, so the ONLY thing
    // separating them is which message is emitted. A timeout must not be
    // rendered in the vocabulary of the mt#2632 Bun truncation defect, which
    // is what produced two documented wrong diagnoses.
    const fs = buildFixtureFs() as unknown as FsLike;
    const timedOut = await runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: timedOutFake,
    });
    const truncated = await runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: adapt(() => ({ exitCode: 0, combined: "bun test v1.3.14\n" })),
    });

    expect(timedOut.reason).not.toContain("truncated");
    expect(timedOut.reason).toContain("wall-clock budget");
    expect(truncated.reason).toContain("truncated");
    expect(truncated.reason).not.toContain("TIMED OUT");
    // And they disagree on the thing that matters to the operator:
    expect(timedOut.ok).toBe(true);
    expect(truncated.ok).toBe(false);
  });

  test("the FAILURE path names the selected test files, not just how many (mt#4303)", async () => {
    // Until mt#4303 this branch returned `relatedCount` — a number — while the
    // PASS branch joined the whole list. The file list is exactly what a
    // bisection needs, so the gate withheld it on the only path where anyone
    // wants it. Three consecutive mt#3501 investigations (its sixth, seventh
    // and eighth instances) each recorded that the N-file list "was again not
    // printed"; it was never produced, so no amount of looking would have
    // found it.
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = await runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: adapt((files) => ({
        exitCode: 1,
        combined: [" 0 pass", " 1 fail", ranLine(1, files.length)].join("\n"),
      })),
    });

    expect(result.ok).toBe(false);
    // The failure reason itself is still there -- this ADDS, it does not replace.
    expect(result.reason).toContain("1 failing test(s)");
    // ...and now the selection is too.
    expect(result.reason).toContain("foo.test.ts");
    expect(result.reason).toContain("1 related test file(s) selected");
  });

  test("the TIMEOUT path names the selection too (mt#4303)", async () => {
    // The deferral branch had the same gap: it reported the COUNT of selected
    // files and not which ones. A deferral is precisely when the operator is
    // told to go look elsewhere, so naming the set matters as much as it does
    // on the failure path.
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = await runFastRelatedTestGate(["src/foo.ts"], repoRoot, {
      fs,
      runBunTest: timedOutFake,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toContain("TIMED OUT");
    expect(result.reason).toContain("foo.test.ts");
    expect(result.reason).toContain("related test file(s) selected");
  });

  test("the selection is space-separated so it can be pasted after `bun test` (mt#4303)", async () => {
    // The PASS path joins with ", " and is deliberately unchanged (a criterion
    // of mt#4303). The failure/timeout rendering is space-separated instead,
    // so the tail is directly usable as an argument list rather than needing
    // the commas stripped first.
    const fs = buildFixtureFs() as unknown as FsLike;
    // Two files so the join has something to join. `src/mcp/server.ts` runs in
    // its own partition, which does not matter here: `describeSelection`
    // renders the whole `related` set, not the failing partition's slice.
    const result = await runFastRelatedTestGate(["src/foo.ts", MCP_SOURCE_FILE], repoRoot, {
      fs,
      runBunTest: adapt((files) => ({
        exitCode: 1,
        combined: [" 0 pass", " 1 fail", ranLine(1, files.length)].join("\n"),
      })),
    });

    expect(result.ok).toBe(false);

    // Assert the marker EXISTS before slicing on it. An earlier draft of this
    // test sliced on `indexOf("selected: ")` without checking, and `indexOf`
    // returns -1 when the marker is absent -- so the slice silently succeeded
    // against the UNFIXED source and the test passed either way. Caught by
    // running it as a negative control (mem#729: a test never observed failing
    // has no discriminating power).
    const marker = "selected: ";
    const markerAt = result.reason.indexOf(marker);
    expect(markerAt).toBeGreaterThanOrEqual(0);

    const selection = result.reason.slice(markerAt + marker.length);
    expect(selection.split(" ").length).toBeGreaterThan(1);
    expect(selection).not.toContain(",");
  });

  test("a dot-directory selection is ./-anchored so it is actually pasteable (mt#4303)", async () => {
    // PR #3150 R1 (BLOCKING). "Space-separated" is not sufficient for the
    // copy-pasteable criterion: bun treats a bare dot-directory argument like
    // `.minsky/hooks/guard.test.ts` as a NAME filter, not a path — it matches
    // nothing, runs zero tests, and emits no completion summary (the exact
    // silent-skip this gate's own `toBunTestPath` was added to prevent, and
    // which the fail-closed gate then reads as a failure).
    //
    // So a selection rendered without anchoring hands the reader a command
    // that looks right and does nothing. Render through the same
    // `toBunTestPath` the runner already uses.
    const fs = buildFixtureFs() as unknown as FsLike;
    const result = await runFastRelatedTestGate([HOOK_SOURCE_FILE], repoRoot, {
      fs,
      runBunTest: adapt((files) => ({
        exitCode: 1,
        combined: [" 0 pass", " 1 fail", ranLine(1, files.length)].join("\n"),
      })),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain(`./${HOOK_TEST_FILE}`);
    // ...and NOT the unanchored form, which is what bun silently ignores.
    expect(result.reason).not.toContain(` ${HOOK_TEST_FILE}`);
  });

  test("the TOTAL budget bounds the gate across partitions, not just per-partition (PR #2733 R1)", async () => {
    // A per-partition budget alone leaves the total unbounded in the NUMBER of
    // partitions, and the outer wrapper treats its own kill as a hard FAILURE
    // — so an unbounded total reintroduces the unpassable state on the one
    // path where a timeout is not a deferral. Here every partition burns its
    // whole budget; the gate must stop and defer rather than run all of them.
    const fs = buildFixtureFs() as unknown as FsLike;
    const budgets: number[] = [];
    const result = await runFastRelatedTestGate(
      ["src/foo.ts", MCP_SOURCE_FILE, SERVICE_SOURCE_FILE],
      repoRoot,
      {
        fs,
        runBunTest: async (_files, _preload, _ignore, _cwd, budgetMs) => {
          budgets.push(budgetMs ?? -1);
          return {
            exitCode: 1,
            combined: "bun test v1.3.14\n",
            timedOut: true,
            elapsedMs: budgetMs ?? 0,
            budgetMs: budgetMs ?? 0,
            timeoutMessage: "partition stopped at its wall-clock budget.",
          };
        },
      }
    );
    // The FIRST timed-out partition already defers, so the gate never spends
    // an unbounded multiple of the partition budget.
    expect(result.ok).toBe(true);
    expect(result.reason).toContain("TIMED OUT");
    expect(budgets.length).toBe(1);
    // And the budget handed to a partition never exceeds the total.
    expect(budgets[0]).toBeLessThanOrEqual(90_000);
  });

  test("a large related set is RUN, not skipped -- monotonic in change size (mt#3765 SC3)", async () => {
    // Replaces the RELATED_TEST_CAP skip test. The cap inverted the risk
    // gradient: a set over it was skipped and passed, so a LARGER staged change
    // was checked LESS than a smaller one. Commit latency is now bounded by the
    // per-partition watchdog instead, which applies to every set equally.
    const files: Record<string, string> = {};
    const many: string[] = [];
    for (let i = 0; i < 45; i++) {
      const base = `capfile${i}`;
      files[`${repoRoot}/src/${base}.ts`] = `export const ${base} = ${i};\n`;
      files[`${repoRoot}/src/${base}.test.ts`] =
        `import { ${base} } from "./${base}";\ntest("${base}", () => ${base});\n`;
      many.push(`src/${base}.ts`);
    }
    const fs = createMockFilesystem(files) as unknown as FsLike;

    let invocations = 0;
    const result = await runFastRelatedTestGate(many, repoRoot, {
      fs,
      runBunTest: adapt((f) => {
        invocations++;
        return {
          exitCode: 0,
          combined: [" 45 pass", " 0 fail", ranLine(45, f.length)].join("\n"),
        };
      }),
    });
    expect(result.relatedCount).toBeGreaterThan(40);
    expect(invocations).toBeGreaterThan(0); // it RAN — the old cap skipped here
    expect(result.ok).toBe(true);
    expect(result.reason).not.toContain("exceeds the fast-gate cap");
  });

  // Bun path-vs-filter quirk: a bare dot-directory path (".minsky/...") is a
  // NAME filter to bun test, matching nothing -> no completion summary ->
  // fail-closed failure on a fully passing change. First live hit: the
  // mt#2446 commit (related tests under .minsky/hooks/).
  test("dot-directory related tests are passed as ./-prefixed paths to the runner", async () => {
    const fs = buildFixtureFs() as unknown as FsLike;
    const calls: string[][] = [];
    const result = await runFastRelatedTestGate([HOOK_SOURCE_FILE], repoRoot, {
      fs,
      runBunTest: adapt((files) => {
        calls.push(files);
        return {
          exitCode: 0,
          combined: [" 1 pass", " 0 fail", ranLine(1, files.length)].join("\n"),
        };
      }),
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([[`./${HOOK_TEST_FILE}`]]);
  });
});

describe("toBunTestPath (mt#2446 dot-directory fix)", () => {
  const ANCHORED_FOO = "./src/foo.test.ts";
  const ANCHORED_GUARD = `./${HOOK_TEST_FILE}`;

  test("prefixes bare repo-relative paths", () => {
    expect(toBunTestPath("src/foo.test.ts")).toBe(ANCHORED_FOO);
    expect(toBunTestPath(HOOK_TEST_FILE)).toBe(ANCHORED_GUARD);
  });

  test("leaves already-anchored paths unchanged", () => {
    expect(toBunTestPath(ANCHORED_FOO)).toBe(ANCHORED_FOO);
    expect(toBunTestPath("/abs/path/foo.test.ts")).toBe("/abs/path/foo.test.ts");
  });

  test("leaves parent-relative ../ paths unchanged (PR #2135 R1) — but a bare dot-directory still gets prefixed", () => {
    expect(toBunTestPath("../outside/foo.test.ts")).toBe("../outside/foo.test.ts");
    expect(toBunTestPath(HOOK_TEST_FILE)).toBe(ANCHORED_GUARD);
  });
});
