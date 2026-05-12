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
 * Execute a command with proper cleanup to prevent hanging
 * Ensures child processes and their stdio streams are properly closed
 */
export async function executeCommand(
  command: string,
  options: Record<string, unknown> = {}
): Promise<{ stdout: string; stderr: string }> {
  // Add explicit cleanup options to prevent hanging
  const execOptions = {
    encoding: "utf8" as const,
    ...(options as ExecOptions),
    // Kill child process if parent exits
    killSignal: "SIGTERM" as const,
    // Set maximum buffer sizes to prevent memory issues
    maxBuffer: 1024 * 1024 * 10, // 10MB
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
