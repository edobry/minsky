/**
 * Tests for the concurrent bulk-mutation guard (mt#4055).
 *
 * The load-bearing properties are the trigger's narrowness and the deny's precision. A guard that
 * fired on a dry-run, or on a script merely NAMED in some other argument, would stand between the
 * operator and their tooling for no benefit — so the no-fire cases carry as much weight as the
 * deny case.
 *
 * The process probe is INJECTED throughout. Nothing here patches a module the guard reaches
 * itself, and no test shells out to `pgrep` — the decision is observable because it was designed
 * to take its dependency as an argument (`testing-standards.mdc` §Testable Design).
 */

import { describe, expect, test } from "bun:test";

import {
  buildDenialReason,
  decide,
  findBulkMutationInvocation,
  OVERRIDE_ENV,
  type ProcessProbe,
  type RunningProcess,
} from "./block-concurrent-bulk-mutation";

/** The script from the originating incident, reused as this file's worked example. */
const BACKFILL_SCRIPT = "scripts/backfill-agent-tool-call-projection.ts";
const BACKFILL_NAME = "backfill-agent-tool-call-projection.ts";

/** The other run's real coordinates from that incident. */
const OTHER_PID = 26946;
const OTHER_ELAPSED = "03:16:33";

const noneRunning: ProcessProbe = () => [];

const oneRunning =
  (proc: Partial<RunningProcess> = {}): ProcessProbe =>
  () => [
    {
      pid: OTHER_PID,
      elapsed: OTHER_ELAPSED,
      command: `bun ${BACKFILL_SCRIPT} --execute`,
      ...proc,
    },
  ];

describe("findBulkMutationInvocation", () => {
  test("matches a script invoked with --execute", () => {
    const found = findBulkMutationInvocation(`bun ${BACKFILL_SCRIPT} --execute`);
    expect(found?.scriptPath).toBe(BACKFILL_SCRIPT);
    expect(found?.scriptName).toBe(BACKFILL_NAME);
    expect(found?.flag).toBe("--execute");
  });

  test("matches --apply as well as --execute", () => {
    expect(findBulkMutationInvocation("bun scripts/migrate-task-kinds.ts --apply")?.flag).toBe(
      "--apply"
    );
  });

  test("matches regardless of flag position or extra arguments", () => {
    const found = findBulkMutationInvocation(
      "bun scripts/backfill-guard-events.ts --execute --batch-size=50 --verify-sample=10"
    );
    expect(found?.scriptName).toBe("backfill-guard-events.ts");
  });

  test("matches an absolute path", () => {
    const found = findBulkMutationInvocation(
      "bun /Users/x/Projects/minsky/scripts/dedupe-transcript-lines.ts --execute"
    );
    expect(found?.scriptName).toBe("dedupe-transcript-lines.ts");
  });

  // --- no-fire cases: these are the ones that keep the guard usable -----------------

  test("does NOT match a dry-run (no execute-class flag)", () => {
    expect(findBulkMutationInvocation(`bun ${BACKFILL_SCRIPT}`)).toBeNull();
    expect(findBulkMutationInvocation(`bun ${BACKFILL_SCRIPT} --dry-run`)).toBeNull();
  });

  test("does NOT match a flag that merely starts with an execute-class flag", () => {
    // A prefix match here would fire on an unrelated option and train the reader to override.
    expect(
      findBulkMutationInvocation("bun scripts/backfill-guard-events.ts --execute-after=2026-01-01")
    ).toBeNull();
  });

  test("does NOT match --execute with no script path in the same segment", () => {
    expect(findBulkMutationInvocation("minsky persistence migrate --execute")).toBeNull();
  });

  test("does NOT match a script named in a non-executing command", () => {
    // Reading or grepping a script is not running it.
    expect(
      findBulkMutationInvocation("grep -n execute scripts/backfill-guard-events.ts")
    ).toBeNull();
  });

  test("is quote-aware: a separator inside quotes cannot manufacture a match", () => {
    // The `--execute` here is quoted text belonging to the echo, not a flag on the script.
    expect(findBulkMutationInvocation("echo 'run scripts/foo.ts --execute'; ls")).toBeNull();
  });

  test("finds the invocation in a later segment of a chained command", () => {
    const found = findBulkMutationInvocation(
      "git status; bun scripts/repair-transcript-metadata.ts --execute"
    );
    expect(found?.scriptName).toBe("repair-transcript-metadata.ts");
  });
});

describe("decide", () => {
  test("no invocation → no probe result and nothing to report", () => {
    const result = decide("bun test packages/", noneRunning);
    expect(result.invocation).toBeNull();
    expect(result.running).toEqual([]);
  });

  test("invocation with nothing else running → allowed", () => {
    const result = decide("bun scripts/backfill-guard-events.ts --execute", noneRunning);
    expect(result.invocation).not.toBeNull();
    expect(result.running).toEqual([]);
  });

  test("invocation with the same script already running → the collision is surfaced", () => {
    const result = decide(`bun ${BACKFILL_SCRIPT} --execute --verify-sample=50`, oneRunning());
    expect(result.invocation?.scriptName).toBe(BACKFILL_NAME);
    expect(result.running).toHaveLength(1);
    expect(result.running[0]?.pid).toBe(OTHER_PID);
  });

  test("probes on the script NAME, so an absolute path still finds a relative-path run", () => {
    // The originating incident's two runs spelled the path differently; matching on the basename
    // is what makes them the same script.
    const probed: string[] = [];
    const recordingProbe: ProcessProbe = (name) => {
      probed.push(name);
      return [];
    };
    decide("bun /abs/path/scripts/clear-ambiguous-spawn-links.ts --execute", recordingProbe);
    expect(probed).toEqual(["clear-ambiguous-spawn-links.ts"]);
  });
});

describe("buildDenialReason", () => {
  const invocation = {
    scriptPath: BACKFILL_SCRIPT,
    scriptName: BACKFILL_NAME,
    flag: "--execute",
  };

  test("names the script, the other PID, and how long it has been running", () => {
    const reason = buildDenialReason(invocation, oneRunning()(""));
    expect(reason).toContain(BACKFILL_SCRIPT);
    expect(reason).toContain(String(OTHER_PID));
    expect(reason).toContain(OTHER_ELAPSED);
  });

  test("tells the reader not to infer the owner from a log filename", () => {
    // The originating incident got the owning task wrong exactly this way, so the remedy text
    // carries the correction rather than leaving it to be rediscovered.
    expect(buildDenialReason(invocation, oneRunning()("")).toLowerCase()).toContain("log filename");
  });

  test("names the override", () => {
    expect(buildDenialReason(invocation, oneRunning()(""))).toContain(OVERRIDE_ENV);
  });

  test("omits the elapsed clause when ps could not report it", () => {
    const reason = buildDenialReason(invocation, oneRunning({ elapsed: null })(""));
    expect(reason).toContain(`PID ${OTHER_PID}`);
    expect(reason).not.toContain("running null");
  });
});
