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
 * - `maxbuffer` — WE killed it because output exceeded `maxBuffer`. Also not the
 *                 command's choice, and a different remedy from `timeout`.
 * - `signal`    — something else signalled it (an operator, the OOM killer).
 * - `unknown`   — the error carried no shape we recognize.
 */
export type ExecFailureKind = "exit" | "timeout" | "maxbuffer" | "signal" | "unknown";

export interface ExecFailure {
  kind: ExecFailureKind;
  /** Present only for `kind: "exit"` — the command's real exit code. */
  exitCode?: number;
  /** The signal used, when one was involved. */
  signal?: string;
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
 */
export function classifyExecFailure(error: unknown): ExecFailure {
  const err = error as {
    code?: number | string | null;
    killed?: boolean;
    signal?: string | null;
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

  // No exit code. `killed` is Node telling us IT did the killing, which for
  // this helper means the `timeout` option elapsed (maxBuffer already returned
  // above on its string code).
  if (err.killed === true) {
    return signal === undefined ? { kind: "timeout" } : { kind: "timeout", signal };
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

  try {
    const result = await promisifiedExec(command, execOptions as ExecOptions);
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
      stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
    };
  } catch (error) {
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
