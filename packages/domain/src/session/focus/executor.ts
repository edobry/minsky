/**
 * Default command executor + AppleScript permission-error classification
 * (mt#2285).
 */
import type { CommandExecResult, CommandExecutor } from "./types";

/**
 * Default command executor: shells out via `Bun.spawnSync` (project
 * convention -- `node:child_process` is restricted, see `bun_over_node.mdc`;
 * mirrors `defaultLsofRunner` in `../attachment-lsof.ts` and `isPidAlive` in
 * `../attachment.ts`). Never throws -- a spawn failure (binary not found,
 * etc.) is reported as a non-zero exitCode with the error message in stderr,
 * so every adapter has exactly one failure shape to handle.
 *
 * mt#2285 hard sandbox constraint: this function performs REAL process
 * execution and must never be invoked by the implementation/test sandbox --
 * only by the operator's post-merge spot-check running the real CLI. Every
 * test in this module and its siblings injects a mock `CommandExecutor`
 * instead of exercising this function.
 */
export const defaultCommandExecutor: CommandExecutor = async (argv) => {
  try {
    const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    };
  } catch (err) {
    return classifySpawnFailure(err, argv);
  }
};

/**
 * Classify a thrown spawn-time failure (binary not found, exec permission
 * denied, etc.) as distinct from a process that started and exited non-zero.
 * `Bun.spawnSync` throws synchronously for this class of failure (rather than
 * returning a non-zero exit code), which previously got flattened into a
 * generic `exitCode: 1` with the raw exception message as stderr -- adapters
 * that pattern-match specific stderr text (notably AppleScript permission
 * detection) could then misattribute a missing binary to an in-app error (R1
 * review finding, mt#2285).
 *
 * Pure and exported so it can be unit tested with a synthetic Error object
 * (mimicking Bun's ENOENT shape) without ever invoking `Bun.spawnSync` for
 * real -- consistent with the sandbox constraint that no test in this module
 * touches the real executor.
 */
export function classifySpawnFailure(err: unknown, argv: string[]): CommandExecResult {
  const bin = argv[0] ?? "<unknown command>";
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  const isNotFound = code === "ENOENT" || /no such file or directory|not found/i.test(message);

  return {
    exitCode: 1,
    stdout: "",
    stderr: isNotFound ? `command not found: ${bin}` : message,
    spawnError: true,
  };
}

/**
 * Classify whether a failed AppleScript (`osascript`) invocation failed
 * because a macOS Automation permission was denied, vs. some other error.
 *
 * Matches the well-known errAEEventNotPermitted OSStatus (-1743) and its
 * associated "not authorized to send Apple events" message text that
 * `osascript` surfaces on stderr when System Settings > Privacy & Security >
 * Automation has not granted the calling process permission to control the
 * target application (iTerm2 or Terminal).
 *
 * IMPORTANT: this function only pattern-matches a stderr STRING -- it never
 * invokes AppleScript itself. Per the mt#2285 sandbox constraint, tests
 * exercise it by constructing the error shape directly rather than triggering
 * a real permission denial.
 */
export function isAppleScriptPermissionError(result: CommandExecResult): boolean {
  if (result.exitCode === 0) return false;
  const text = result.stderr.toLowerCase();
  return text.includes("-1743") || text.includes("not authorized to send apple events");
}

/** Actionable remediation text for a denied macOS Automation permission. */
export function appleScriptPermissionMessage(appName: string): string {
  return (
    `macOS blocked Automation access to ${appName} (Apple Events not permitted). ` +
    `Grant it in System Settings > Privacy & Security > Automation -- find the app ` +
    `running this command (e.g. Terminal, iTerm2, or your IDE) and enable its ` +
    `checkbox for "${appName}". Then retry.`
  );
}
