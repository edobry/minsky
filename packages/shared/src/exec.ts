import { exec, type ExecOptions } from "child_process";

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
  /**
   * True when `killSignal` was not enough and SIGKILL was required (mt#3418).
   *
   * Distinguishes "we killed it" from "we tried to kill it and it did not die,"
   * which have different remedies: the first is a budget to raise, the second a
   * command that traps or cannot service SIGTERM and needs looking at.
   */
  escalated?: boolean;
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
 * Stamped when `killSignal` was insufficient and SIGKILL was required (mt#3418).
 *
 * Same `Symbol.for` reasoning as {@link KILLED_BY_TIMEOUT}, and the same
 * division of labour: Node reports the signal that finally landed, never
 * whether an earlier, gentler one was ignored first. Only the code that sent
 * both knows that.
 */
export const REQUIRED_SIGKILL = Symbol.for("minsky.exec.requiredSigkill");

/** Record that this error's child had to be SIGKILLed after ignoring `killSignal`. */
export function markRequiredSigkill<T>(error: T): T {
  if (error !== null && typeof error === "object") {
    Object.defineProperty(error, REQUIRED_SIGKILL, {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  return error;
}

/**
 * How long a child gets to service `killSignal` before SIGKILL (mt#3418).
 *
 * Matches `scripts/spawn-with-watchdog.ts`'s `DEFAULT_GRACE_MS` — this repo's
 * other two-stage kill, and the shape mt#3418's spec says to reuse rather than
 * invent a second one. Duplicated rather than imported because
 * `packages/shared` must not depend on `scripts/`; the two are cross-referenced
 * in both directions so a change to one is visible from the other.
 *
 * This is the DEFAULT, overridable per call via the `killGraceMs` option, which
 * is stripped before the options reach Node. It was very nearly a bare
 * constant: the delay only elapses for a child that is IGNORING the signal, so
 * it measures how wedged a process can get — a property of processes, not of
 * any caller's workload, and none of the ~100 call sites has grounds to hold a
 * different opinion. What made it an option is that the escalation is otherwise
 * untestable at reasonable cost: every exercise of the SIGKILL path would spend
 * 5 seconds, most of it with a busy-looping child, in a suite whose measured
 * failures are already contention-driven (mt#3704). A knob one caller needs
 * beats a 5-second CPU burn in the regression suite.
 *
 * @see scripts/spawn-with-watchdog.ts — the sibling implementation
 */
export const EXEC_KILL_GRACE_MS = 5_000;

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
    [REQUIRED_SIGKILL]?: boolean;
  } | null;

  if (!err || typeof err !== "object") return { kind: "unknown" };

  const signal = typeof err.signal === "string" ? err.signal : undefined;
  // Only ever set, never set to false: absent means "no escalation happened",
  // which is also what an error from a caller that does not stamp looks like.
  const escalation = err[REQUIRED_SIGKILL] === true ? { escalated: true } : {};

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
    return signal === undefined ? { kind, ...escalation } : { kind, signal, ...escalation };
  }

  // Signalled by something outside this process.
  if (signal !== undefined) return { kind: "signal", signal };

  return { kind: "unknown" };
}

/**
 * Run `exec` with a timeout that actually ENFORCES (mt#3418).
 *
 * ## What was wrong with letting Node own the timeout
 *
 * Node's `timeout` option sends `killSignal` once and then goes back to waiting
 * for the child to close. A child that ignores or cannot service that signal
 * runs to completion, and the call **resolves successfully**. Measured against
 * a child with a no-op SIGTERM handler under a 2000 ms budget:
 *
 * ```
 * Node's timeout:  elapsed=25015ms  err=NO   killed=undefined  signal=undefined  stdout=""
 * two-stage kill:  elapsed=3009ms   err=yes  killed=true       signal=SIGKILL    code=null
 * ```
 *
 * Note the first row's `stdout`: not only is the timeout lost, so is the output
 * the child did produce, because Node tears the pipe down when it fires. The
 * caller is handed a clean, empty, SUCCESSFUL result for a command that blew
 * its budget by 12x — which is why the old behavior was silent rather than
 * merely wrong. Every gate built on `execAsync` could report a pass that way.
 *
 * ## Why we own the whole timeout instead of layering on Node's
 *
 * Keeping Node's timer and adding an escalation on top would put two
 * independent killers on one child, in two places, with a race between them.
 * Owning it gives one path. The well-behaved case is unchanged by construction:
 * we send the same signal at the same deadline Node would have, and Node builds
 * its callback error with `killed: child.killed` — true for any successful
 * `kill()`, whoever called it — so the rejection is shape-identical and
 * `classifyExecFailure` needs no new branch.
 *
 * `promisify(exec)` cannot express this at all: it discards the `ChildProcess`
 * that the escalation has to signal. Hence the callback form.
 *
 * ## Scope limit: grandchildren
 *
 * `exec` runs through `/bin/sh`, so SIGKILL reaches the shell. A grandchild the
 * shell spawned survives it. Reaping the whole tree means killing the process
 * GROUP, which requires detaching the child at spawn time and so changes signal
 * delivery for every one of this helper's call sites — out of scope here, and
 * the same boundary `scripts/spawn-with-watchdog.ts` drew for the same reason.
 *
 * @see scripts/spawn-with-watchdog.ts — the sibling two-stage kill (mt#3156)
 */
/**
 * Put the captured output back on a rejection, the way `promisify(exec)` did.
 *
 * Node's plain `exec` callback hands stdout/stderr as ARGUMENTS and leaves the
 * error object bare; the `err.stdout = stdout` assignment lived in Node's
 * custom promisify hook. Anything that catches from `executeCommand` and reads
 * `error.stdout` was relying on that hook, so replacing it means reproducing it
 * — a compatibility obligation, not an improvement.
 */
function attachOutput(error: unknown, stdout: string | Buffer, stderr: string | Buffer): void {
  if (error === null || typeof error !== "object") return;
  Object.assign(error, { stdout, stderr });
}

function runWithEnforcedTimeout(
  command: string,
  execOptions: ExecOptions & { killSignal: NodeJS.Signals; killGraceMs?: number }
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  const timeoutMs =
    typeof execOptions.timeout === "number" && execOptions.timeout > 0
      ? execOptions.timeout
      : undefined;
  const graceMs =
    typeof execOptions.killGraceMs === "number" && execOptions.killGraceMs > 0
      ? execOptions.killGraceMs
      : EXEC_KILL_GRACE_MS;

  // Node must not arm a killer of its own — this function is the only one. Both
  // keys are stripped from what Node receives (`killGraceMs` is not a Node
  // option at all); the ORIGINAL `execOptions.timeout` is still what the
  // caller's timeout attribution reads downstream.
  const { timeout: _ownedHere, killGraceMs: _notANodeOption, ...nodeOptions } = execOptions;

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let escalated = false;
    // A list rather than two named handles: the escalation timer is created
    // inside the first one's callback, so the exec callback needs to be able to
    // cancel a timer that may not exist yet without reaching for a binding that
    // is still in its temporal dead zone.
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const clearTimers = () => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    };

    const arm = (delayMs: number, onFire: () => void) => {
      const timer = setTimeout(onFire, delayMs);
      // Never hold the event loop open on this helper's account — the child's
      // own stdio handles already keep it alive for exactly as long as needed.
      timer.unref?.();
      timers.push(timer);
    };

    const child = exec(command, nodeOptions as ExecOptions, (error, stdout, stderr) => {
      clearTimers();

      if (error) {
        // Reattach the captured output to the error, which is NOT something
        // Node's plain callback does — it was supplied by the custom promisify
        // hook this function replaced (`err.stdout = stdout` in
        // `exec[promisify.custom]`). Callers depend on it: the pre-commit
        // ESLint step recovers violation JSON from a non-zero exit via
        // `execErr.stdout`, and would see every lint failure as an empty result
        // without this. Caught by an existing test rather than reasoned out.
        attachOutput(error, stdout, stderr);
        // The signal that landed is on the error; whether a gentler one was
        // ignored first is only known here.
        if (escalated) markRequiredSigkill(error);
        reject(error);
        return;
      }

      if (timedOut) {
        // The child outlived even SIGKILL — an uninterruptible-sleep case — and
        // Node is reporting a clean exit for a command we already gave up on.
        // Resolving here would reintroduce the exact silent pass this function
        // exists to remove, so synthesize the rejection Node did not produce.
        // Shaped like a real kill rejection (`killed: true`, null `code`) so it
        // classifies identically rather than becoming its own special case.
        const synthetic = Object.assign(
          new Error(
            `Command failed: ${command} — exceeded its ${timeoutMs}ms timeout and survived ` +
              `${execOptions.killSignal} followed by SIGKILL`
          ),
          { killed: true, code: null, signal: "SIGKILL" }
        );
        attachOutput(synthetic, stdout, stderr);
        markRequiredSigkill(synthetic);
        reject(synthetic);
        return;
      }

      resolve({ stdout, stderr });
    });

    if (timeoutMs === undefined) return;

    arm(timeoutMs, () => {
      timedOut = true;
      try {
        child.kill(execOptions.killSignal);
      } catch {
        // Already gone between the timer firing and the signal — nothing to do.
      }
      arm(graceMs, () => {
        // Still neither exited nor signalled: it is ignoring the signal or is
        // too wedged to service it. SIGKILL cannot be caught.
        if (child.exitCode === null && child.signalCode === null) {
          escalated = true;
          try {
            child.kill("SIGKILL");
          } catch {
            // Same race as above.
          }
        }
      });
    });
  });
}

/**
 * The options {@link executeCommand} understands, as documentation (PR #2957 R1).
 *
 * `killGraceMs` previously existed only in a private function's signature, so
 * the only way to learn the option was to read the implementation. Everything
 * else here is passed through to Node's `exec` unchanged.
 *
 * **Why the parameter is still `Record<string, unknown>` and not this type.**
 * Applying it was tried and reverted in the same round. `extends ExecOptions`
 * constrains `env` to `ProcessEnv`, and under `src/cockpit/web/tsconfig.json`
 * Vite's `ImportMetaEnv` (`DEV`/`PROD`/`SSR`: boolean) is visible on
 * `process.env`, so `execGitWithTimeout`'s `env: { ...process.env, … }` stops
 * compiling — a pre-existing type artifact in that project's view, with no
 * runtime component, that has nothing to do with timeout enforcement. Tightening
 * the signature is worth doing on its own; doing it here would have meant
 * touching a shared git helper from a PR about killing subprocesses.
 */
export interface ExecuteCommandOptions {
  /**
   * How long the child gets to service `killSignal` before SIGKILL, in ms.
   * Defaults to {@link EXEC_KILL_GRACE_MS}. Stripped before the options reach
   * Node, which has no such option.
   */
  killGraceMs?: number;
  /** Wall-clock budget in ms. Enforced — see {@link runWithEnforcedTimeout}. */
  timeout?: number;
  /** Max captured output in bytes. Defaults to 10MB; a caller's value wins. */
  maxBuffer?: number;
  /** Working directory for the child. */
  cwd?: string;
  [key: string]: unknown;
}

/**
 * Execute a command with proper cleanup to prevent hanging
 * Ensures child processes and their stdio streams are properly closed
 *
 * @param options see {@link ExecuteCommandOptions} for the keys this helper
 * adds on top of Node's `ExecOptions`.
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
  //
  // MONOTONIC (PR #2957 R1). `Date.now()` can step backwards or forwards — an
  // NTP correction, a manual clock change — and this reading decides whether a
  // kill gets labelled a timeout. A backward step makes elapsed look shorter
  // than the budget and the timeout is reported as a bare `killed`; a forward
  // step invents a timeout for a kill that had another reason, which is exactly
  // the guess mt#3923 removed. `performance.now()` cannot jump, and
  // `scripts/spawn-with-watchdog.ts` already chose it for the same reason.
  const startedAt = performance.now();

  try {
    const result = await runWithEnforcedTimeout(command, execOptions);
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
      elapsedMs: performance.now() - startedAt,
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
