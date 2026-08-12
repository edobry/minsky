/**
 * Concurrent bulk-mutation guard (mt#4055).
 *
 * Denies invoking a repo script in its EXECUTE mode while another process is already running
 * that same script. Two concurrent writers against the same production table is duplicated work
 * at best and interleaved mutation at worst, and nothing else in the system notices: both runs
 * exit 0.
 *
 * ## Why this guard exists at all
 *
 * Every duplication gate in this repo is bound to a task-graph surface — `parallel-work-guard.ts`
 * dispatches on `tasks_create` / `session_start` / `tasks_dispatch`, `/plan-task` gate (g) runs at
 * planning, the duplicate-check record and duplicate-signature scan fire on `tasks_create`. None
 * is bound to an EXECUTION surface. So `bun scripts/<x>.ts --execute` — the single most
 * consequential duplicable action available — reaches production through no check at all.
 *
 * Originating incident (2026-08-12): an approved authorization ask licensed clearing an orphan
 * backlog. Acting on it, an agent ran `scripts/backfill-agent-tool-call-projection.ts --execute`
 * while another actor had been running the identical full-keyset script for ~2.5 hours under
 * mt#4050. The collision surfaced by chance, while tailing the log. `mem#999` records the
 * reasoning error: an approval answers *may this be done*, never *is it already being done*.
 *
 * ## Why the trigger is not a curated script list
 *
 * mt#4055's spec proposed a maintained list of bulk-mutation script paths, on the reasoning that
 * `--execute` alone would over-fire. Measured before building: 30 scripts under `scripts/` accept
 * `--execute`, and they do include benign ones (`smoke-*`, `verify-npm-pack-install`).
 *
 * That measurement inverts the conclusion rather than confirming it. The deny condition here is
 * not "this script is dangerous" — it is "a second copy of THIS script is already running", which
 * is very nearly never intended, for a smoke test exactly as much as for a backfill. Keying on the
 * concurrency rather than on the identity makes the curated list unnecessary, which removes the
 * staleness failure mode a list carries (a newly added script silently outside the guard). The
 * deviation from the spec is recorded in mt#4055 `## Design change`.
 *
 * ## Why it denies from day one, rather than shipping calibration-first
 *
 * The repo-wide observer convention is calibration-first, and it is aimed at heuristics with a
 * real false-positive surface — trigger-phrase matching over agent prose, where the corpus is
 * unproven. This check has no such surface: it compares a structured command string against a
 * fixed flag set, then asks the process table a yes/no question. There is no paraphrase axis and
 * no judgment. That is the same matcher class `block-secret-file-read` cites for shipping its
 * mt#4017 extension straight to deny, and the cost asymmetry points the same way: a false positive
 * costs one override on a command the operator can immediately re-run, while a false negative is a
 * second writer on production state.
 */

import { CANARY_MODE_ENV } from "./types";
import type { ToolHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { splitTopLevel } from "./command-shape";

export const OVERRIDE_ENV = "MINSKY_ALLOW_CONCURRENT_BULK_MUTATION";

/**
 * Flags that put a dry-run-first script into its writing mode.
 *
 * `--execute` is this repo's dominant convention (`operational-safety-dry-run-first.mdc` requires
 * it); `--apply` covers the handful of scripts that chose the other spelling. Both are matched as
 * whole arguments, so `--execute-later` or a path containing the word cannot trigger the check.
 */
const EXECUTE_FLAGS: readonly string[] = ["--execute", "--apply"];

/** Matches a `scripts/<name>.ts` argument anywhere in a command segment. */
const SCRIPT_PATH_PATTERN = /(?:^|[\s"'=/])((?:[\w./-]*\/)?scripts\/[\w.-]+\.ts)\b/;

export interface BulkMutationInvocation {
  /** The script path exactly as it appeared in the command. */
  scriptPath: string;
  /** The basename, which is what the process probe matches on. */
  scriptName: string;
  /** Which execute-class flag was present. */
  flag: string;
}

/**
 * The trigger decision, pure over the command string.
 *
 * Quote-aware segment splitting is reused from `command-shape` so a `;` inside a quoted argument
 * cannot manufacture or suppress a match — the same reasoning `chained-verification-commands`
 * records for its own split.
 */
export function findBulkMutationInvocation(command: string): BulkMutationInvocation | null {
  for (const segment of splitTopLevel(command)) {
    const flag = EXECUTE_FLAGS.find((candidate) =>
      // Whole-argument match: the flag must be delimited, not a prefix of a longer token.
      new RegExp(`(?:^|\\s)${candidate}(?:\\s|=|$)`).test(segment)
    );
    if (!flag) continue;

    const match = SCRIPT_PATH_PATTERN.exec(segment);
    if (!match?.[1]) continue;

    // A script invoked through an interpreter or directly via its shebang both count; what
    // matters is that this segment runs it, not how it was spelled.
    const scriptPath = match[1];
    const scriptName = scriptPath.split("/").pop() ?? scriptPath;
    return { scriptPath, scriptName, flag };
  }
  return null;
}

export interface RunningProcess {
  pid: number;
  /** Elapsed run time as reported by `ps`, e.g. `03:16:33`. Absent if it could not be read. */
  elapsed: string | null;
  /** The matched command line, truncated. */
  command: string;
}

/**
 * Probes the process table for other live runs of a script.
 *
 * Injected rather than imported at the callsite so the decision can be tested against a supplied
 * process list, with no patching of a module the guard reaches itself (`testing-standards.mdc`
 * §Testable Design).
 */
export type ProcessProbe = (scriptName: string) => RunningProcess[];

/** Cap on the command string retained per match, so the denial message stays bounded. */
const MAX_COMMAND_CHARS = 120;

export const defaultProcessProbe: ProcessProbe = (scriptName) => {
  try {
    // `pgrep -f` matches against the full command line. It excludes itself, and at PreToolUse the
    // command being guarded has not started, so anything returned here is genuinely another run.
    const found = Bun.spawnSync(["pgrep", "-f", scriptName], { stdout: "pipe", stderr: "pipe" });
    const pids = new TextDecoder()
      .decode(found.stdout)
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    if (pids.length === 0) return [];

    const details = Bun.spawnSync(["ps", "-o", "pid=,etime=,command=", "-p", pids.join(",")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return new TextDecoder()
      .decode(details.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pid, elapsed, ...rest] = line.split(/\s+/);
        return {
          pid: Number.parseInt(pid ?? "", 10),
          elapsed: elapsed ?? null,
          command: rest.join(" ").slice(0, MAX_COMMAND_CHARS),
        };
      })
      .filter((entry) => Number.isInteger(entry.pid));
  } catch {
    // Fail OPEN. This guard exists to catch a duplicate run, not to stand between the operator
    // and their tooling: if the process table cannot be read, the command proceeds. The
    // alternative — denying because a probe failed — would make an unreadable `ps` look
    // identical to a real collision.
    return [];
  }
};

export function buildDenialReason(
  invocation: BulkMutationInvocation,
  running: readonly RunningProcess[]
): string {
  const listed = running
    .map((p) => `  PID ${p.pid}${p.elapsed ? ` (running ${p.elapsed})` : ""}: ${p.command}`)
    .join("\n");
  return (
    `\`${invocation.scriptPath}\` is ALREADY RUNNING in another process — this call would make ` +
    `a second concurrent writer.\n\n${listed}\n\n` +
    `An authorization to perform an operation is not evidence that it is not already underway ` +
    `(mem#999). Before re-running:\n` +
    `  1. Find who owns the running one — check for a task covering it (\`tasks_search\`), and ` +
    `do not infer the owner from a log filename.\n` +
    `  2. If another actor owns it, stand down and let it finish; it reports its own result.\n` +
    `  3. If the process is stale or yours, stop it before starting a new one.\n\n` +
    `Override with ${OVERRIDE_ENV}=1 if two concurrent runs are genuinely intended.`
  );
}

export function decide(
  command: string,
  probe: ProcessProbe
): { invocation: BulkMutationInvocation | null; running: RunningProcess[] } {
  const invocation = findBulkMutationInvocation(command);
  if (!invocation) return { invocation: null, running: [] };
  return { invocation, running: probe(invocation.scriptName) };
}

export function run(input: ToolHookInput, _ctx: DispatchContext): GuardOutcome | null {
  if (process.env[OVERRIDE_ENV] === "1") return null;

  const toolInput = input.tool_input ?? {};
  const command = typeof toolInput["command"] === "string" ? (toolInput["command"] as string) : "";
  if (!command) return null;

  // The trigger is pure, so it is evaluated even in canary mode; the process probe is not, so a
  // canary run stops at the trigger and never shells out. Stated explicitly so a later edit does
  // not silently give the canary a dependency on the host's process table.
  if (process.env[CANARY_MODE_ENV] === "1") {
    const invocation = findBulkMutationInvocation(command);
    return invocation ? { calibration: { outcome: "clean", canary: true } } : null;
  }

  const { invocation, running } = decide(command, defaultProcessProbe);
  if (!invocation) return null;

  const base = {
    ts: new Date().toISOString(),
    sessionId: input.session_id ?? null,
    toolName: input.tool_name ?? null,
    scriptPath: invocation.scriptPath,
    flag: invocation.flag,
    concurrentCount: running.length,
    // The diversity axis is the SCRIPT, not the full command string: a raw command is near-unique
    // and would satisfy a calibration sweep's distinct-phrase gate by construction (mt#3781).
    phrase: invocation.scriptName,
  };

  if (running.length === 0) {
    return { calibration: { ...base, outcome: "clean" } };
  }

  return {
    deny: { reason: buildDenialReason(invocation, running) },
    calibration: { ...base, outcome: "matched" },
  };
}
