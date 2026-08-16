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
import { splitOutsideQuotes } from "./command-shape";

export const OVERRIDE_ENV = "MINSKY_ALLOW_CONCURRENT_BULK_MUTATION";

/**
 * Flags that put a dry-run-first script into its writing mode.
 *
 * `--execute` is this repo's dominant convention (`operational-safety-dry-run-first.mdc` requires
 * it); `--apply` covers the handful of scripts that chose the other spelling. Both are matched as
 * whole arguments, so `--execute-later` or a path containing the word cannot trigger the check.
 */
const EXECUTE_FLAGS: readonly string[] = ["--execute", "--apply"];

/**
 * Matches a WHOLE token that is a `scripts/<name>.ts` path.
 *
 * Anchored (mt#4088). The predecessor matched a script path anywhere inside a segment, which
 * made the guard fire on any command that merely MENTIONED a script — the path was never bound
 * to an invocation. Anchoring is half the fix; {@link isPrefixTokenAt} is the other half,
 * requiring the token to sit in COMMAND POSITION rather than be an argument to something else.
 *
 * POSIX-only by design (PR #2937 R1 NON-BLOCKING): this guard runs on `Bash` / `session_exec`
 * commands, whose paths are forward-slash on every platform this repo targets, and the repo's own
 * `scripts/` names are all `[\w.-]`. A path with an exotic character or a Windows separator is a
 * MISS (no fire), never a false fire — so the narrow class degrades recall only, in the same
 * direction as `chained-verification-commands`' stale-pattern-list note. Widen it if a script is
 * ever added whose name this cannot match.
 */
const SCRIPT_TOKEN_PATTERN = /^(?:[\w./-]*\/)?scripts\/[\w.-]+\.ts$/;

/** Interpreters that run a script named as their next argument. */
const INTERPRETERS: ReadonlySet<string> = new Set([
  "bun",
  "bunx",
  "npx",
  "node",
  "deno",
  "tsx",
  "ts-node",
]);

/** Wrappers that run the command that follows them. */
const WRAPPERS: ReadonlySet<string> = new Set(["env", "nohup", "time", "timeout"]);

/** A `VAR=value` environment assignment, which can only ever precede the command. */
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A bare duration/count — `timeout`'s argument, and nothing else's. */
const DURATION_PATTERN = /^\d+(?:\.\d+)?[smhd]?$/;

/** An option token: `-v`, `--bun`, `--loader=x`. Not a bare `-` or `--`. */
const OPTION_PATTERN = /^--?[A-Za-z0-9]/;

/** What the prefix walk has seen so far, for the two context-dependent token classes. */
interface PrefixState {
  /** An interpreter or wrapper has appeared, so an option now belongs to it. */
  seenLauncher: boolean;
  /** `timeout` has appeared, so a bare number is its duration argument. */
  seenTimeout: boolean;
}

/**
 * Strip ONE layer of matching surrounding quotes.
 *
 * `bun 'scripts/x.ts' --execute` is an ordinary invocation, and an anchored whole-token pattern
 * would miss it (PR #3023 R1) — a silent false negative, the direction that matters most for a
 * guard whose job is to catch a second writer. Only a MATCHED pair is stripped, so a token
 * carrying one stray quote from a split-up quoted string (`"text`) is left as-is and still fails
 * the script test.
 */
function stripQuotes(token: string): string {
  const first = token[0];
  if ((first === '"' || first === "'") && token.length >= 2 && token.endsWith(first)) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Whether the token at `index` can precede the command WITHOUT being it.
 *
 * Contextual rather than a flat set (PR #3023 R1). A flat set admitted `run`, `exec` and any bare
 * number anywhere in the prefix, so a command whose own name happened to be one of those, or that
 * took a numeric first argument, would let a later script path read as the invocation. Each token
 * class now names where it may appear:
 *
 *   - an assignment: anywhere in the prefix — that is the only place shell grammar allows it;
 *   - an interpreter or wrapper: anywhere in the prefix, since they nest (`nohup timeout 5 bun …`);
 *   - `run`: only directly after an interpreter (`bun run`), never standing alone;
 *   - `exec`: only as the very first token, which is the only position the shell builtin occupies;
 *   - a bare number: only directly after `timeout`, whose argument it is;
 *   - an option: only once a launcher has been seen, so it belongs to that launcher
 *     (`bun --bun scripts/x.ts`) and cannot carry a script into command position behind some
 *     other command's flag — `mytool --spec-file scripts/x.ts --execute` still stops at `mytool`.
 *
 * **Known residue, deliberately not covered (PR #3023 R3).** A SEPARATED option value still stops
 * the walk: in `node --loader ts-node/esm scripts/x.ts --execute`, the bare `ts-node/esm` is
 * indistinguishable from a command name, so admitting it would mean admitting any token after a
 * launcher — which is the over-broad rule this whole task removed. Measured before accepting the
 * gap: of 435 script invocations across `package.json`, `.github/workflows/`, `docs/`,
 * `.minsky/rules/` and `scripts/`, **433 are the bare `bun scripts/X.ts` form and none uses an
 * interpreter option**. The residue is a false NEGATIVE, so it degrades recall only.
 */
function isPrefixTokenAt(tokens: readonly string[], index: number, state: PrefixState): boolean {
  const token = stripQuotes(tokens[index] ?? "");
  const previous = index > 0 ? stripQuotes(tokens[index - 1] ?? "") : undefined;

  if (ASSIGNMENT_PATTERN.test(token)) return true;
  if (INTERPRETERS.has(token) || WRAPPERS.has(token)) return true;
  if (token === "run") return previous !== undefined && INTERPRETERS.has(previous);
  if (token === "exec") return index === 0;
  // Keyed on `timeout` having been SEEN, not on it being the immediately preceding token: its
  // own options sit between the two (`timeout --preserve-status 120 bun …`). Still bounded — a
  // bare number with no `timeout` anywhere in the prefix remains a command, not an argument.
  if (DURATION_PATTERN.test(token)) return state.seenTimeout;
  if (OPTION_PATTERN.test(token)) return state.seenLauncher;
  return false;
}

/**
 * Segments of `command`, treating a NEWLINE as a separator alongside `;`, `&&` and `||`.
 *
 * `splitTopLevel` deliberately splits on those three only, so a multi-line command arrives as ONE
 * segment and text from a heredoc body is matched against a flag from a later line — the mt#4088
 * false positive.
 *
 * Reuses `command-shape`'s quote-aware walker rather than splitting the raw string (PR #3023 R1).
 * A naive `String.split("\n")` cuts quoted strings in half, and the halves then re-parse as
 * commands: `echo "…\nbun scripts/x.ts --execute more"` produced a fresh false positive of exactly
 * the class this task fixes. The walker also absorbs backslash-escape pairs, so a `\`-continued
 * line stays ONE segment for free — no pre-pass, and no risk of the split turning a real
 * invocation into a miss.
 *
 * `splitTopLevel` itself is untouched: it is shared with five other guards, two of them deny-tier.
 */
function splitSegments(command: string): string[] {
  return splitOutsideQuotes(command, (ch, next) => {
    if (ch === "\n" || ch === ";") return 1;
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) return 2;
    return 0;
  });
}

/**
 * Tokens of one segment, splitting on whitespace OUTSIDE quotes.
 *
 * Quote-aware for the same reason the segment split is (PR #3023 R2). A plain `split(/\s+/)`
 * breaks a quoted value in half, and the halves are then judged as separate tokens:
 * `FOO="a b" bun scripts/x.ts --execute` tokenized to `FOO="a`, `b"`, … and the stray `b"` read
 * as this segment's command, so a real invocation stopped firing. False negatives are the costly
 * direction here — the guard exists to catch a second writer on shared state.
 */
function tokenize(segment: string): string[] {
  return splitOutsideQuotes(segment, (ch) => (/\s/.test(ch) ? 1 : 0));
}

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
 * records for its own split. {@link splitSegments} adds the newline boundary on top of it.
 *
 * The order of the two checks is deliberate (mt#4088): find the INVOKED script first, then look
 * for an execute flag AFTER it. The predecessor asked the two questions independently of each
 * other — "is there an execute flag in this segment?" and "is there a script path in this
 * segment?" — and never checked that the flag belonged to the script's invocation, so a command
 * that merely mentioned a script beside an unrelated `--execute` matched.
 */
export function findBulkMutationInvocation(command: string): BulkMutationInvocation | null {
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);

    // COMMAND POSITION: walk the prefix until a token is either the script or a real command.
    // A script invoked through an interpreter (`bun scripts/x.ts`) or directly via its shebang
    // (`./scripts/x.ts`) both count; a script named as an ARGUMENT to some other command
    // (`... --spec-file scripts/x.ts`) does not, because that command's own name stops the walk.
    let scriptIndex = -1;
    const state: PrefixState = { seenLauncher: false, seenTimeout: false };
    for (let index = 0; index < tokens.length; index++) {
      const token = stripQuotes(tokens[index] ?? "");
      if (SCRIPT_TOKEN_PATTERN.test(token)) {
        scriptIndex = index;
        break;
      }
      // The first non-prefix token IS this segment's command. Anything after it is an argument,
      // so no later script path can be the invocation — stop rather than keep scanning.
      if (!isPrefixTokenAt(tokens, index, state)) break;
      if (INTERPRETERS.has(token) || WRAPPERS.has(token)) state.seenLauncher = true;
      if (token === "timeout") state.seenTimeout = true;
    }
    if (scriptIndex === -1) continue;

    // The flag must belong to THAT invocation, so only tokens after the script count.
    const flag = EXECUTE_FLAGS.find((candidate) =>
      tokens
        .slice(scriptIndex + 1)
        .map(stripQuotes)
        // Whole-argument match: `--execute-after=…` is a different flag, not this one.
        .some((token) => token === candidate || token.startsWith(`${candidate}=`))
    );
    if (!flag) continue;

    const scriptPath = stripQuotes(tokens[scriptIndex] ?? "");
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

/** The fields every calibration record carries, whatever the outcome. */
function recordBase(input: ToolHookInput, invocation: BulkMutationInvocation) {
  return {
    ts: new Date().toISOString(),
    sessionId: input.session_id ?? null,
    toolName: input.tool_name ?? null,
    scriptPath: invocation.scriptPath,
    flag: invocation.flag,
    // The diversity axis is the SCRIPT, not the full command string: a raw command is near-unique
    // and would satisfy a calibration sweep's distinct-phrase gate by construction (mt#3781).
    phrase: invocation.scriptName,
  };
}

export function run(input: ToolHookInput, _ctx: DispatchContext): GuardOutcome | null {
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

  // The override is checked AFTER the trigger, not before, so that using it leaves a RECORD
  // (PR #2937 R1). Returning `null` up front made an overridden bulk mutation indistinguishable
  // from a command this guard never governed — the one event most worth having in the log is a
  // human deciding to run a second concurrent writer anyway. Checked after the trigger and before
  // the probe: an override means the answer does not matter, so there is no reason to shell out.
  const invocationForOverride = findBulkMutationInvocation(command);
  if (process.env[OVERRIDE_ENV] === "1") {
    if (!invocationForOverride) return null;
    return {
      calibration: {
        ...recordBase(input, invocationForOverride),
        concurrentCount: null,
        outcome: "overridden",
      },
    };
  }

  const { invocation, running } = decide(command, defaultProcessProbe);
  if (!invocation) return null;

  const base = { ...recordBase(input, invocation), concurrentCount: running.length };

  if (running.length === 0) {
    return { calibration: { ...base, outcome: "clean" } };
  }

  return {
    deny: { reason: buildDenialReason(invocation, running) },
    calibration: { ...base, outcome: "matched" },
  };
}
