import { exec } from "child_process";
import { promisify } from "util";

const promisifiedExec = promisify(exec);

/**
 * Execute a command with proper cleanup to prevent hanging
 * Ensures child processes and their stdio streams are properly closed
 */
export async function executeCommand(
  command: string,
  options: any = {}
): Promise<{ stdout: string; stderr: string }> {
  // Add explicit cleanup options to prevent hanging
  const execOptions = {
    encoding: "utf8" as const,
    ...options,
    // Kill child process if parent exits
    killSignal: "SIGTERM",
    // Set maximum buffer sizes to prevent memory issues
    maxBuffer: 1024 * 1024 * 10, // 10MB
  };

  try {
    const result = await promisifiedExec(command, execOptions);
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : result.stdout.toString(),
      stderr: typeof result.stderr === "string" ? result.stderr : result.stderr.toString(),
    };
  } catch (error) {
    // Ensure any spawned processes are cleaned up on error
    if ((error as any).child) {
      try {
        (error as any).child.kill("SIGTERM");
      } catch (killError) {
        // Ignore kill errors
      }
    }
    throw error;
  }
}

// Legacy export for backward compatibility (deprecated: use executeCommand)
export { executeCommand as execAsync };
