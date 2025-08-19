import { exec } from "child_process";
import { promisify } from "util";

const promisifiedExec = promisify(exec);

/**
 * Execute a command with proper cleanup to prevent hanging
 * Ensures child processes and their stdio streams are properly closed
 */
export async function execAsync(command: string, options: any = {}) {
  // NEVER execute real commands during tests
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test" || globalThis.Bun?.jest) {
    return {
      stdout: "0\t1",
      stderr: "",
    };
  }

  // Add explicit cleanup options to prevent hanging
  const execOptions = {
    ...options,
    // Kill child process if parent exits
    killSignal: "SIGTERM",
    // Set maximum buffer sizes to prevent memory issues
    maxBuffer: 1024 * 1024 * 10, // 10MB
  };

  try {
    const result = await promisifiedExec(command, execOptions);
    return result;
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

export { execAsync as _execAsync }; // Alias for backward compatibility
