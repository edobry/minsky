/**
 * Bulk process-kill guard (mt#4081).
 *
 * Denies a command that kills MANY processes at once — `kill` with three or more PIDs, or
 * `pkill`/`killall` naming an interactive process class. The killed processes are, in this
 * environment, the operator's live working set: agent sessions, editors, shells. Recreating
 * them is not free even when the underlying state survives on disk.
 *
 * ## Why a guard rather than another detector
 *
 * The operator-deferral family's shipped mechanism (mt#2459, extended by mt#3999's surface E)
 * catches the DEFER path — prose in which the agent hands a fixable thing to the operator. The
 * ACT path emits no prose: the agent concludes a capability is unavailable and quietly builds a
 * workaround. On 2026-08-13 that workaround was `kill` on 26 live sessions, proposed because a
 * single AppleScript probe returned a no-op and was read as "the capability does not exist."
 * The operator denied the call by hand. One `WebSearch`, run afterwards, returned the iTerm2
 * Python API's `Window.async_set_tabs()` — a live, non-destructive move, which is what actually
 * shipped the request.
 *
 * A detector cannot be the load-bearing half of that fix: this family's detector ships
 * `INJECTION_ENABLED = false` (calibration-first per ADR-024), so even a correct fire emits
 * nothing to the agent in the turn that matters. A PreToolUse deny does.
 *
 * ## Why it denies from day one, rather than shipping calibration-first
 *
 * Same matcher class as `block-concurrent-bulk-mutation` and `block-secret-file-read`'s mt#4017
 * extension: a structured command string against a fixed shape, no paraphrase axis, no
 * judgment. The repo's calibration-first convention aims at trigger-phrase matching over agent
 * prose, where the corpus is unproven. Cost asymmetry points the same way — a false positive
 * costs one override on a command the operator can immediately re-run; a false negative costs
 * the working set.
 *
 * ## What it deliberately does NOT catch
 *
 * A PID the agent itself backgrounded this session. `mt#4081`'s spec listed that as an
 * exclusion; the hook input carries no record of which PIDs the agent spawned, and inferring it
 * from the process tree would be a guess with a silent failure mode. Killing three or more of
 * your own background jobs in one command is rare, and the override covers it. Recorded as a
 * deviation in the task spec rather than approximated here.
 */

import type { ToolHookInput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { splitTopLevel } from "./command-shape";

export const OVERRIDE_ENV = "MINSKY_ALLOW_BULK_PROCESS_KILL";

/**
 * How many PID arguments make a `kill` a BULK kill.
 *
 * Three, not two: `kill <pid> <pid>` is a plausible cleanup of a process and its child, while
 * three-plus is a sweep. Grounded in the originating incident's shape (26 PIDs in one command)
 * and in `decision-defaults.mdc §Thresholds` — the number comes from observed cadence, not from
 * a round figure.
 */
export const BULK_PID_THRESHOLD = 3;

/**
 * Process names whose mass-termination takes out an interactive working set.
 *
 * `pkill`/`killall` are mass-kill by construction, so the list is about which TARGETS matter
 * rather than about which verbs are dangerous. A name outside this list (a stuck test runner, a
 * dev server) is a MISS by design: the guard degrades recall rather than standing between the
 * operator and ordinary process management.
 */
export const INTERACTIVE_PROCESS_CLASSES: readonly string[] = [
  "claude",
  "node",
  "bun",
  "zsh",
  "bash",
  "fish",
  "iterm",
  "iterm2",
  "terminal",
  "ssh",
  "tmux",
  "code",
  "cursor",
];

/** Signals that do not terminate anything — `kill -0` is a liveness probe. */
const NON_TERMINATING_SIGNALS = new Set(["0"]);

export interface BulkKillInvocation {
  /** `kill`, `pkill`, or `killall`. */
  verb: string;
  /** PIDs named, for the `kill` form. */
  pids: number[];
  /** The process-class name, for the `pkill`/`killall` form. */
  target: string | null;
}

/**
 * A kill verb as the LEADING token of a segment, optionally path-qualified.
 *
 * Leading-token rather than anywhere-in-segment (PR #2954 R1 BLOCKING): matching anywhere let
 * `git commit -m 'fix: kill the retry loop'` read as a kill, since the quote characters around a
 * message are not segment separators. The verb of a command is its first token, so that is what
 * is matched. `sudo kill …` / `time kill …` are consequently misses — recall-only, in the same
 * direction as this file's other documented narrowings.
 *
 * The optional `[\w./-]*\/` prefix closes a gap the same review surfaced from the other side:
 * `/bin/kill 1 2 3` previously did not match at all, because the character before the verb was a
 * slash rather than whitespace.
 */
const KILL_SEGMENT = /^\s*(?:[\w.\-/]*\/)?(kill|pkill|killall)\b\s*([^;&|]*)/i;

/** Parses `-9` / `-TERM` / `-s TERM` off the front of a kill's arguments. */
function stripSignal(args: string[]): { signal: string | null; rest: string[] } {
  if (args.length === 0) return { signal: null, rest: args };
  const first = args[0] ?? "";
  if (first === "-s" || first === "--signal") {
    return { signal: (args[1] ?? "").toLowerCase(), rest: args.slice(2) };
  }
  if (/^-[A-Za-z0-9]+$/.test(first)) {
    return { signal: first.slice(1).toLowerCase(), rest: args.slice(1) };
  }
  return { signal: null, rest: args };
}

/** One segment of a command whose leading token is a kill verb. */
interface KillSegment {
  verb: string;
  /** The segment verbatim, trimmed — the evidence a reader needs to see. */
  segment: string;
  signal: string | null;
  /** Arguments after the verb, with any leading signal removed. */
  rest: string[];
}

/**
 * Every kill-verb segment in the command, parsed once.
 *
 * The single parse both public entry points below consume. Quote-aware segment splitting is
 * reused from `command-shape` so a `;` inside a quoted argument cannot manufacture or suppress a
 * match — the same reasoning `block-concurrent-bulk-mutation` records for its own split.
 */
function* eachKillSegment(command: string): Generator<KillSegment> {
  for (const segment of splitTopLevel(command)) {
    const match = KILL_SEGMENT.exec(segment);
    if (!match?.[1]) continue;
    const args = (match[2] ?? "").trim().split(/\s+/).filter(Boolean);
    const { signal, rest } = stripSignal(args);
    yield {
      verb: match[1].toLowerCase(),
      segment: segment.trim(),
      signal,
      rest: stripRedirections(rest),
    };
  }
}

/**
 * Remove shell redirections from a kill's arguments (mt#4193).
 *
 * Done HERE, at tokenization, rather than in either consumer's own filter — because the two
 * consumers were wrong in OPPOSITE directions from the same cause, and a per-consumer filter
 * fixes one at a time:
 *
 * - `findBulkKill` takes a `pkill`/`killall` target as the last non-flag argument, so
 *   `pkill -f node 2>/dev/null` targeted `2>/dev/null` — bare-named `null` after the path strip,
 *   which is on no interactive-class list. The guard did not deny a command it denies without
 *   the redirect.
 * - `findKillInvocation` COUNTS targets, so the space-separated form `kill 4821 > /dev/null` read
 *   the PATH as a second target and made a single-process cleanup look like a multi-target kill.
 *
 * Two token shapes, because the shell writes redirections both ways. A token that CONTAINS an
 * operator and does not END with one carries its own target (`2>/dev/null`) and is dropped alone;
 * a token that ends with the operator (`>`, `2>`, `>>`) takes the NEXT token as its target, so
 * both are dropped. `2>&1` never reaches here intact — `&` is a segment separator — which is why
 * a trailing bare `2>` is an ordinary case rather than a malformed one.
 */
function stripRedirections(args: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? "";
    if (!/[<>]/.test(token)) {
      kept.push(token);
      continue;
    }
    if (/[<>]$/.test(token)) index++;
  }
  return kept;
}

/** A kill this command actually performs, with the targets it names. */
export interface KillInvocation {
  /** `kill`, `pkill`, or `killall`. */
  verb: string;
  /** The segment the verb leads, verbatim. */
  segment: string;
  /** Non-flag arguments after the verb — PIDs, job specs, process names, or expansions. */
  targets: string[];
}

/**
 * The first TERMINATING kill this command performs, if any — the shared half of the trigger.
 *
 * Exported because `operator-deferral-detector`'s surface F needs the same parse: its own inline
 * regex was the subject of PR #2954 R1's quote-awareness finding, and two copies of this
 * reasoning is exactly how they diverge. It returns the invocation rather than the bare verb
 * (mt#4111) because a consumer that has to say WHAT fired needs the segment and the targets —
 * reconstructing either from the command string is the second copy this export exists to avoid.
 *
 * A non-terminating signal (`kill -0`, a liveness probe) is skipped here as it already is in
 * {@link findBulkKill}: it destroys nothing, so it is not a kill for either caller's purposes.
 */
export function findKillInvocation(command: string): KillInvocation | null {
  for (const { verb, segment, signal, rest } of eachKillSegment(command)) {
    if (signal !== null && NON_TERMINATING_SIGNALS.has(signal)) continue;
    return { verb, segment, targets: rest.filter(isTargetToken) };
  }
  return null;
}

/**
 * True for an argument that names something to kill, rather than a flag.
 *
 * The ONE target filter both entry points use (mt#4193). Redirections are gone before this
 * runs — {@link stripRedirections} removes them at tokenization, so every consumer sees the same
 * argument list and neither can drift into its own idea of what a target is. That was not true
 * until mt#4193: this filter carried the redirection test and only `findKillInvocation` called
 * it, which is how the same defect produced an under-deny in one consumer and an over-count in
 * the other.
 */
function isTargetToken(token: string): boolean {
  return !token.startsWith("-");
}

/** The verb of {@link findKillInvocation}, for callers that need nothing else. */
export function findKillVerb(command: string): string | null {
  return findKillInvocation(command)?.verb ?? null;
}

/**
 * The trigger decision, pure over the command string.
 */
export function findBulkKill(command: string): BulkKillInvocation | null {
  for (const { verb, signal, rest } of eachKillSegment(command)) {
    if (signal !== null && NON_TERMINATING_SIGNALS.has(signal)) continue;

    if (verb === "kill") {
      // `$(...)`/`$VAR` expansions are not PIDs we can count, so a command that kills an
      // expanded list is a MISS. Recall-only degradation, in the same direction as the
      // interactive-class list above.
      const pids = rest
        .filter((token) => /^\d+$/.test(token))
        .map((token) => Number.parseInt(token, 10));
      if (pids.length >= BULK_PID_THRESHOLD) return { verb, pids, target: null };
      continue;
    }

    // pkill / killall: the target is the last non-flag argument. Through the SAME filter
    // `findKillInvocation` uses (mt#4193) — a second inline copy of "non-flag" is how the
    // redirection defect stayed fixed in one consumer and live in this one.
    const target = rest.filter(isTargetToken).pop() ?? null;
    if (!target) continue;
    const bare = target.replace(/^.*\//, "").toLowerCase();
    if (INTERACTIVE_PROCESS_CLASSES.includes(bare)) return { verb, pids: [], target: bare };
  }
  return null;
}

export function buildDenialReason(invocation: BulkKillInvocation): string {
  const what =
    invocation.target !== null
      ? `\`${invocation.verb} ${invocation.target}\` terminates every \`${invocation.target}\` process at once`
      : `this kills ${invocation.pids.length} processes at once (${invocation.pids.slice(0, 6).join(", ")}${invocation.pids.length > 6 ? ", …" : ""})`;

  return (
    `Bulk process kill denied — ${what}.\n\n` +
    `If you reached this because a capability looked unavailable, check that conclusion first: ` +
    `one probe of one channel bounds the finding to THAT CHANNEL, never to the capability ` +
    `(claim-confidence.mdc). Run one search for the capability itself before destroying and ` +
    `recreating — a native move/rearrange path usually exists and costs a fraction of the ` +
    `rebuild.\n\n` +
    `If the operator asked you to MOVE, REARRANGE, or REORGANIZE something, destroy-and-recreate ` +
    `is not that operation, however equivalent the end state looks.\n\n` +
    `Override with ${OVERRIDE_ENV}=1 when the mass kill is genuinely what was asked for.`
  );
}

/** The fields every calibration record carries, whatever the outcome. */
function recordBase(input: ToolHookInput, invocation: BulkKillInvocation) {
  return {
    ts: new Date().toISOString(),
    sessionId: input.session_id ?? null,
    toolName: input.tool_name ?? null,
    verb: invocation.verb,
    pidCount: invocation.pids.length,
    target: invocation.target,
    // The diversity axis is the VERB plus target class, not the raw command: a command string
    // carrying PIDs is near-unique and would satisfy a calibration sweep's distinct-phrase gate
    // by construction (mt#3781).
    phrase: invocation.target ? `${invocation.verb} ${invocation.target}` : invocation.verb,
  };
}

export function run(input: ToolHookInput, _ctx: DispatchContext): GuardOutcome | null {
  const toolInput = input.tool_input ?? {};
  const command = typeof toolInput["command"] === "string" ? (toolInput["command"] as string) : "";
  if (!command) return null;

  const invocation = findBulkKill(command);
  if (!invocation) return null;

  // No canary short-circuit, unlike `block-concurrent-bulk-mutation`. That guard stops before its
  // process probe because a canary cannot arrange a second running process; this decision is pure
  // over the command string, so the canary exercises the REAL deny path and the registry declares
  // `expects: "deny"` accordingly. Nothing here touches the host.

  // The override is checked AFTER the trigger so that using it leaves a RECORD — an overridden
  // mass kill is the single event most worth having in the log.
  if (process.env[OVERRIDE_ENV] === "1") {
    return { calibration: { ...recordBase(input, invocation), outcome: "overridden" } };
  }

  return {
    deny: { reason: buildDenialReason(invocation) },
    calibration: { ...recordBase(input, invocation), outcome: "matched" },
  };
}
