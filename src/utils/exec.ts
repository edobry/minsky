import { exec, type ExecOptions } from "child_process";
import { promisify } from "util";

const promisifiedExec = promisify(exec);

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- promisifiedExec overload resolution requires cast when options has dynamic shape
    const result = await promisifiedExec(command, execOptions as any);
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
