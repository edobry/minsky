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
  run,
  type ProcessProbe,
  type RunningProcess,
} from "./block-concurrent-bulk-mutation";
import type { DispatchContext } from "./registry";
import type { ToolHookInput } from "./types";

/** The script from the originating incident, reused as this file's worked example. */
const BACKFILL_SCRIPT = "scripts/backfill-agent-tool-call-projection.ts";
const BACKFILL_NAME = "backfill-agent-tool-call-projection.ts";

/** A second real script, used where a case needs one distinct from the worked example. */
const GUARD_EVENTS_NAME = "backfill-guard-events.ts";

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
    expect(found?.scriptName).toBe(GUARD_EVENTS_NAME);
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

  // --- mt#4088: the flag must belong to the script's INVOCATION ---------------------
  //
  // The predecessor asked "is there an execute flag?" and "is there a script path?" of the same
  // segment, independently. Both questions could be answered YES by text belonging to different
  // commands — or to no command at all.

  test("does NOT match a script named only in a heredoc body (the mt#4088 live denial)", () => {
    // Verbatim shape of the command denied on 2026-08-13. `--execute` is `tasks edit`'s own
    // dry-run-to-apply flag; the script appears only as prose being written INTO a spec.
    const command = [
      "SP=/tmp/specs ; cat >> $SP/mt3875.md <<'EOF'",
      "Counts were taken with: MINSKY_PREPUSH_FULL_SUITE=1 bun scripts/run-tests-gated.ts",
      "EOF",
      "timeout 120 bun run src/cli.ts tasks edit mt#3875 --spec-file $SP/mt3875.md --execute",
    ].join("\n");
    expect(findBulkMutationInvocation(command)).toBeNull();
  });

  test("does NOT match a script passed as an ARGUMENT to a different command", () => {
    // One segment, no separator: the script is the value of --spec-file, and --execute belongs
    // to `tasks edit`. Command position is what tells them apart.
    expect(
      findBulkMutationInvocation(
        "bun run src/cli.ts tasks edit mt#3875 --spec-file scripts/foo.ts --execute"
      )
    ).toBeNull();
  });

  test("does NOT match across a newline: script on one line, unrelated flag on the next", () => {
    // No heredoc anywhere — two ordinary lines. This is why stripping heredoc bodies alone
    // would not have been sufficient.
    expect(
      findBulkMutationInvocation("bun scripts/foo.ts\nbun run src/cli.ts tasks edit mt#1 --execute")
    ).toBeNull();
  });

  test("does NOT match a wrapped command that merely names a script", () => {
    expect(
      findBulkMutationInvocation(
        "timeout 120 bun run src/cli.ts tasks edit --spec scripts/x.ts --execute"
      )
    ).toBeNull();
  });

  // --- the newline split must not cost us a true positive --------------------------

  test("still matches across a backslash line continuation", () => {
    // Splitting on raw newlines would break this invocation in half and miss it.
    const found = findBulkMutationInvocation(
      "bun scripts/backfill-guard-events.ts \\\n  --execute"
    );
    expect(found?.scriptName).toBe(GUARD_EVENTS_NAME);
    expect(found?.flag).toBe("--execute");
  });

  test("still matches a script invoked on its own line", () => {
    const found = findBulkMutationInvocation(
      "git status\nbun scripts/repair-transcript-metadata.ts --execute"
    );
    expect(found?.scriptName).toBe("repair-transcript-metadata.ts");
  });

  test("still matches an env-assigned and wrapper-prefixed invocation", () => {
    const found = findBulkMutationInvocation(
      "MINSKY_X=1 timeout 300 bun scripts/backfill-guard-events.ts --execute"
    );
    expect(found?.scriptName).toBe(GUARD_EVENTS_NAME);
  });

  test("still matches a direct shebang invocation", () => {
    const found = findBulkMutationInvocation("./scripts/backfill-guard-events.ts --apply");
    expect(found?.scriptName).toBe(GUARD_EVENTS_NAME);
    expect(found?.flag).toBe("--apply");
  });

  // --- PR #3023 R1: the four ways the first fix was too loose or too tight ----------

  test("still matches a QUOTED script token", () => {
    // R1: anchoring the pattern to a whole token made `bun 'scripts/x.ts'` a silent miss.
    // A false negative on this guard means a second writer on shared state goes unblocked.
    for (const command of [
      `bun 'scripts/backfill-guard-events.ts' --execute`,
      `bun "scripts/backfill-guard-events.ts" --execute`,
    ]) {
      expect(findBulkMutationInvocation(command)?.scriptName).toBe(GUARD_EVENTS_NAME);
    }
  });

  test("still matches a quoted execute flag", () => {
    expect(
      findBulkMutationInvocation(`bun scripts/backfill-guard-events.ts '--execute'`)?.flag
    ).toBe("--execute");
  });

  test("does NOT split inside a quoted string that spans a newline", () => {
    // R1: a raw newline split cut this in half, and the second half re-parsed as a command —
    // a NEW false positive of exactly the class this task fixes. The trailing `more` is what
    // makes `--execute` a clean token in the broken version.
    expect(
      findBulkMutationInvocation('echo "see the note\nbun scripts/foo.ts --execute more"')
    ).toBeNull();
  });

  test("does NOT treat a bare number as a launcher prefix except after timeout", () => {
    // R1: allowing any bare number anywhere in the prefix let a numeric first argument carry a
    // later script path into command position.
    expect(findBulkMutationInvocation("5 scripts/foo.ts --execute")).toBeNull();
    // ...but timeout's own argument still is one.
    expect(
      findBulkMutationInvocation("timeout 5 bun scripts/backfill-guard-events.ts --execute")
        ?.scriptName
    ).toBe(GUARD_EVENTS_NAME);
  });

  test("still matches when an env assignment's value contains spaces", () => {
    // R2: a quote-insensitive tokenizer split `FOO="a b"` into `FOO="a` and `b"`, and the stray
    // half read as this segment's command — so a real invocation stopped firing.
    const found = findBulkMutationInvocation(
      `MINSKY_NOTE="a b" bun scripts/backfill-guard-events.ts --execute`
    );
    expect(found?.scriptName).toBe(GUARD_EVENTS_NAME);
    expect(found?.flag).toBe("--execute");
  });

  test("still matches when the interpreter carries its own options", () => {
    // R3: an option before the script stopped the command-position walk, missing a real
    // invocation.
    for (const command of [
      `bun --bun scripts/backfill-guard-events.ts --execute`,
      `bun run --silent scripts/backfill-guard-events.ts --execute`,
      `timeout --preserve-status 120 bun scripts/backfill-guard-events.ts --execute`,
    ]) {
      expect(findBulkMutationInvocation(command)?.scriptName).toBe(GUARD_EVENTS_NAME);
    }
  });

  test("does NOT let an option carry a script into command position behind another command", () => {
    // The bound on the rule above: an option is a prefix token only once a LAUNCHER has been
    // seen, so an unrecognized command's own flag cannot smuggle a script path through.
    expect(findBulkMutationInvocation("mytool --spec-file scripts/foo.ts --execute")).toBeNull();
  });

  test("does NOT treat `run` or `exec` as a prefix out of position", () => {
    // R1: `run` and `exec` were admitted anywhere. `run` is a prefix only after an interpreter,
    // and `exec` only as the very first token.
    expect(findBulkMutationInvocation("run scripts/foo.ts --execute")).toBeNull();
    expect(findBulkMutationInvocation("mytool exec scripts/foo.ts --execute")).toBeNull();
    // ...and both still work where they legitimately appear.
    expect(
      findBulkMutationInvocation("exec bun scripts/backfill-guard-events.ts --execute")?.scriptName
    ).toBe(GUARD_EVENTS_NAME);
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

describe("run — override is recorded, not silent (PR #2937 R1)", () => {
  const ctx = {} as DispatchContext;
  const inputFor = (command: string): ToolHookInput => ({
    session_id: "sess-1",
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });

  const withOverride = <T>(fn: () => T): T => {
    const prior = process.env[OVERRIDE_ENV];
    process.env[OVERRIDE_ENV] = "1";
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[OVERRIDE_ENV];
      else process.env[OVERRIDE_ENV] = prior;
    }
  };

  test("an overridden bulk mutation still writes a calibration record", () => {
    // The whole point: an override is a human deciding to run a second concurrent writer anyway,
    // which is the single event most worth having in the log. Returning null made it
    // indistinguishable from a command the guard never governed.
    const outcome = withOverride(() => run(inputFor(`bun ${BACKFILL_SCRIPT} --execute`), ctx));
    expect(outcome).not.toBeNull();
    expect(outcome?.deny).toBeUndefined();
    expect(outcome?.calibration?.["outcome"]).toBe("overridden");
    expect(outcome?.calibration?.["scriptPath"]).toBe(BACKFILL_SCRIPT);
  });

  test("the override does NOT manufacture a record for a command the guard never governed", () => {
    expect(withOverride(() => run(inputFor("bun test packages/"), ctx))).toBeNull();
  });

  test("an overridden run does not consult the process table", () => {
    // No probe injection is available through `run`, so this asserts the observable proxy: the
    // record carries a null count rather than a probed number.
    const outcome = withOverride(() => run(inputFor(`bun ${BACKFILL_SCRIPT} --execute`), ctx));
    expect(outcome?.calibration?.["concurrentCount"]).toBeNull();
  });
});
