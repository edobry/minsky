import { exec, type ExecOptions } from "child_process";
import { promisify } from "util";

const promisifiedExec = promisify(exec);

/**
 * POSIX-safe shell quoting for a single argument. Wraps the string in single
 * quotes (which suppress ALL shell metacharacter interpretation — `$VAR`,
 * `` `cmd` ``, `\`, `*`, `~`, `;`, `|`, `&`, etc.) and escapes any embedded
 * single quotes via the canonical `'\''` sequence.
 *
 * Use this whenever interpolating user-controlled or external-input strings
 * into a shell command passed to `executeCommand` / `execAsync`. The
 * originating incident (mt#1742) was commit messages containing markdown
 * backticks (e.g., `` `bun install` ``) which were interpreted as command
 * substitution by `/bin/sh -c` — the substituted command (`bun install`) then
 * hung on its own postinstall hook, leaving the parent shell waiting and
 * holding `.git/index.lock`.
 *
 * The argv-shaped alternative (`child_process.execFile` with `shell: false`)
 * is structurally stronger but requires changing the `ExecAsyncFn` interface
 * threaded through the entire git/session call graph. This helper closes the
 * substitution-attack vector at every existing callsite with a single-line
 * wrap, leaving the broader argv refactor as a separate concern if needed.
 *
 * @example
 *   await execAsync(`git -C ${workdir} commit -m ${safeShellQuote(message)}`);
 *
 * @see mt#1742 — originating bug
 * @see https://www.gnu.org/software/bash/manual/html_node/Single-Quotes.html
 */
export function safeShellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * How a command failed, as distinct from whether it failed (mt#3909).
 *
 * - `exit`      — the command ran and exited non-zero. Its exit code is real.
 * - `timeout`   — WE killed it because the `timeout` option elapsed. There is no
 *                 exit code; the command never chose to stop.
 * - `killed`    — the parent killed it, and nothing told us why. Same absence of
 *                 an exit code as `timeout`, without the claim about the reason.
 * - `maxbuffer` — WE killed it because output exceeded `maxBuffer`. Also not the
 *                 command's choice, and a different remedy from `timeout`.
 * - `signal`    — something else signalled it (an operator, the OOM killer).
 * - `unknown`   — the error carried no shape we recognize.
 */
export type ExecFailureKind = "exit" | "timeout" | "killed" | "maxbuffer" | "signal" | "unknown";

export interface ExecFailure {
  kind: ExecFailureKind;
  /** Present only for `kind: "exit"` — the command's real exit code. */
  exitCode?: number;
  /** The signal used, when one was involved. */
  signal?: string;
}

/**
 * Stamped on an error by whoever killed the child BECAUSE its time budget
 * elapsed (mt#3923).
 *
 * Node cannot answer this question. Its docs define `subprocess.killed` as
 * "the child process successfully received a signal from `subprocess.kill()`"
 * — a fact about WHO sent a signal, with nothing about WHY — and describe no
 * property that separates a timeout kill from any other parent-initiated one.
 * So the reason has to travel from the code that HAS it: `executeCommand`
 * stamps this when it is the one that set `timeout`.
 *
 * `Symbol.for` rather than a fresh symbol: the bundle can hold more than one
 * copy of this module, and a stamp from one copy must be legible to another.
 */
export const KILLED_BY_TIMEOUT = Symbol.for("minsky.exec.killedByTimeout");

/**
 * Record that this error's kill was a timeout kill.
 *
 * For callers that run their OWN timer around a child (rather than using
 * `executeCommand`'s `timeout` option) and then classify the result — without
 * this, their kill is reported as `killed`, which is the honest default but
 * less useful than the truth they already hold.
 */
export function markKilledByTimeout<T>(error: T): T {
  if (error !== null && typeof error === "object") {
    Object.defineProperty(error, KILLED_BY_TIMEOUT, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}

/**
 * Is this parent kill attributable to the `timeout` option ELAPSING?
 *
 * PR #2817 R1: the first cut of this stamped a timeout whenever a `timeout`
 * option was set and the child came back killed — which is the same inference
 * this task exists to remove, moved one layer down. Setting a budget is not the
 * same fact as the budget running out.
 *
 * The load-bearing condition is **that the budget actually ran out**. Node kills
 * on timeout only after the full duration, so an elapsed time short of it rules
 * the timeout out. Measured from before the spawn, so the reading errs long —
 * the safe direction, since it can only ever fail to claim a timeout, never
 * invent one.
 *
 * The `aborted` condition is defensive, and deliberately narrower than it looks.
 * Node's own `AbortSignal` path does NOT reach here: an aborted `exec` rejects
 * with `code: "ABORT_ERR"` and no `killed` flag at all (verified by probe, not
 * read from the docs), so `classifyExecFailure` returns on the string-code
 * branch long before the kill branch. This guard covers a caller that runs its
 * own cancellation and kills the child itself while a timeout is also set.
 *
 * Pure so the boundary can be tested at the millisecond without spawning
 * anything, which is the half a real-process test cannot pin reliably.
 */
export function isTimeoutAttributableKill(input: {
  killed: boolean;
  timeoutMs: number | undefined;
  elapsedMs: number;
  aborted: boolean;
}): boolean {
  if (!input.killed) return false;
  // An abort is its own reason, reported by the caller. It wins.
  if (input.aborted) return false;
  if (typeof input.timeoutMs !== "number" || input.timeoutMs <= 0) return false;
  return input.elapsedMs >= input.timeoutMs;
}

/**
 * Classify a caught `exec` error by HOW the command ended.
 *
 * Pure over the error's shape so it can be tested without spawning anything;
 * the integration tests that DO spawn exist to pin that Node's real errors have
 * the shape assumed here, which is the half a pure test cannot establish.
 *
 * ## Why this exists (mt#3909)
 *
 * Node distinguishes these cases on the error object and callers routinely
 * flatten them. `session_exec` did `execError.code ?? 1`, which turns every
 * non-exit failure into a bare `1` — indistinguishable from a command that
 * genuinely exited 1. An agent reading that cannot tell "your command failed"
 * from "we killed your command," and those have opposite remedies: fix the
 * command, versus split the work or run it detached. Guessing wrong in the
 * second direction means re-running a command that already ran.
 *
 * ## The shapes, and why the order of checks matters
 *
 * On a timeout or maxBuffer kill Node sets `killed: true` and leaves `code`
 * null, so `killed` alone cannot separate them. maxBuffer is distinguished by
 * its STRING `code` (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) — which is also why
 * `code` must never be assigned to a numeric `exitCode` without a typeof check.
 * That conflation is a real latent bug in any caller doing `code ?? 1`: a
 * maxBuffer overrun would put a string where a number is declared.
 *
 * ## Why the kill REASON is an argument, not an inference (mt#3923)
 *
 * `killed: true` says the parent sent a signal. It does not say why, and Node
 * exposes nothing that does. Reading it as "timed out" is right for every
 * caller in this repo today only because `executeCommand` is the only thing
 * killing children here — a future caller that kills on operator cancellation
 * or a pre-timeout abort would have that kill silently relabelled a timeout,
 * which is the same class of guess mt#3909 removed one layer down. So an
 * unexplained parent kill is `killed`, and `timeout` is reserved for a kill
 * whose reason was actually reported — via `context.killedDueToTimeout` or the
 * `KILLED_BY_TIMEOUT` stamp `executeCommand` applies.
 */
export function classifyExecFailure(
  error: unknown,
  context?: { killedDueToTimeout?: boolean }
): ExecFailure {
  const err = error as {
    code?: number | string | null;
    killed?: boolean;
    signal?: string | null;
    [KILLED_BY_TIMEOUT]?: boolean;
  } | null;

  if (!err || typeof err !== "object") return { kind: "unknown" };

  const signal = typeof err.signal === "string" ? err.signal : undefined;

  // A string `code` is a Node error identifier, never a process exit code.
  if (typeof err.code === "string") {
    const kind = err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "maxbuffer" : "unknown";
    return signal === undefined ? { kind } : { kind, signal };
  }

  // A numeric code means the process chose its own exit status, even if a
  // signal is also reported — the exit code is the more specific fact.
  if (typeof err.code === "number") {
    return signal === undefined
      ? { kind: "exit", exitCode: err.code }
      : { kind: "exit", exitCode: err.code, signal };
  }

  // No exit code. `killed` is Node telling us the PARENT did the killing —
  // not why (maxBuffer already returned above on its string code). Only a
  // reported reason earns the `timeout` label.
  if (err.killed === true) {
    const kind =
      (context?.killedDueToTimeout ?? err[KILLED_BY_TIMEOUT]) === true ? "timeout" : "killed";
    return signal === undefined ? { kind } : { kind, signal };
  }

  // Signalled by something outside this process.
  if (signal !== undefined) return { kind: "signal", signal };

  return { kind: "unknown" };
}

/**
 * Execute a command with proper cleanup to prevent hanging
 * Ensures child processes and their stdio streams are properly closed
 */
export async function executeCommand(
  command: string,
  options: Record<string, unknown> = {}
): Promise<{ stdout: string; stderr: string }> {
  // Add explicit cleanup options to prevent hanging.
  // Defaults come BEFORE the options spread so callers can override them
  // (PR #1694 R1: maxBuffer was previously set after the spread, silently
  // clamping every caller-provided value to 10MB). killSignal stays after the
  // spread — process-cleanup behavior is this helper's invariant, not a knob.
  const execOptions = {
    encoding: "utf8" as const,
    // Default maximum buffer size to prevent memory issues; callers with
    // known-large outputs (e.g. full-repo eslint --format json) may override.
    maxBuffer: 1024 * 1024 * 10, // 10MB
    ...(options as ExecOptions),
    // Kill child process if parent exits
    killSignal: "SIGTERM" as const,
  };

  // Read before the spawn so the elapsed time can only ever over-report, which
  // is the direction that fails to claim a timeout rather than inventing one.
  const startedAt = Date.now();

  try {
    const result = await promisifiedExec(command, execOptions as ExecOptions);
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
      stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
    };
  } catch (error) {
    // This function set the `timeout` option, so it is the only place that can
    // say a parent kill was a TIMEOUT kill rather than some other kill. Stamp
    // it here; `classifyExecFailure` reports `killed` without it (mt#3923).
    const abortSignal = (execOptions as { signal?: { aborted?: boolean } }).signal;
    const attributable = isTimeoutAttributableKill({
      killed: (error as { killed?: boolean } | null)?.killed === true,
      timeoutMs: typeof execOptions.timeout === "number" ? execOptions.timeout : undefined,
      elapsedMs: Date.now() - startedAt,
      aborted: abortSignal?.aborted === true,
    });
    if (attributable) {
      markKilledByTimeout(error);
    }

    // Ensure any spawned processes are cleaned up on error
    // Node.js exec errors may have a child process reference (non-standard property)
    const execError = error as { child?: { kill: (signal: string) => void } };
    if (execError.child) {
      try {
        execError.child.kill("SIGTERM");
      } catch (killError) {
        // Ignore kill errors
      }
    }
    throw error;
  }
}

// Legacy export for backward compatibility (deprecated: use executeCommand)
export { executeCommand as execAsync };
