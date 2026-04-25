/**
 * OperatorNotify — pure plumbing for notifying the operator.
 *
 * Two delivery channels:
 *   - `bell()` — writes the ASCII BEL character (\x07) to stdout, causing most
 *     terminals to emit an audible or visual alert.
 *   - `notify(title, body)` — on macOS (darwin) shells out to `osascript` to
 *     raise a native notification banner; on all other platforms falls back to a
 *     plain `console.log` so callers don't need to guard on platform.
 *
 * The command executor is injected so unit tests can verify the `osascript`
 * invocation without spawning real processes. See `operator-notify.test.ts`.
 *
 * Zero dependency on the Ask entity — this is pure plumbing.
 */

/**
 * Abstraction over `child_process.spawnSync` / similar. Only the subset needed
 * here is required — keeps the dependency narrow and the test stub simple.
 */
export interface CommandExecutor {
  /**
   * Execute a command with the given arguments.
   * Returns `{ status: number | null }` mirroring `spawnSync` output.
   */
  exec(cmd: string, args: string[]): { status: number | null };
}

/**
 * The operator-notify interface. Implementations deliver alerts through
 * different channels; `SystemOperatorNotify` targets the local desktop.
 */
export interface OperatorNotify {
  /** Write \x07 (BEL) to stdout to trigger a terminal bell. */
  bell(): void;

  /**
   * Raise a native notification banner on the operator's desktop.
   * On macOS calls `osascript`; on other platforms logs to console.
   */
  notify(title: string, body: string): void;
}

/**
 * stdout abstraction — accepts `process.stdout` or any writable that has
 * `write(chunk: string): boolean`. Narrow interface so tests can capture output
 * without spawning a real TTY.
 */
export interface StdoutSink {
  write(chunk: string): boolean;
}

/**
 * Default `CommandExecutor` that delegates to Bun's `spawnSync`.
 *
 * Calling code can pass this into `SystemOperatorNotify` at the composition
 * root; tests substitute a recording stub.
 */
export function makeSpawnExecutor(): CommandExecutor {
  return {
    exec(cmd: string, args: string[]): { status: number | null } {
      // Dynamic import keeps this module loadable in environments where
      // `child_process` is unavailable (e.g., browser bundles).

      const { spawnSync } = require("child_process") as typeof import("child_process");
      const result = spawnSync(cmd, args, { stdio: "ignore" });
      return { status: result.status ?? null };
    },
  };
}

/**
 * Default `StdoutSink` that delegates to `process.stdout`.
 */
export function makeProcessStdout(): StdoutSink {
  return process.stdout;
}

/**
 * Concrete implementation targeting the local desktop.
 *
 * Inject `executor` and `stdout` at the composition root; pass stubs in tests.
 */
export class SystemOperatorNotify implements OperatorNotify {
  private readonly executor: CommandExecutor;
  private readonly stdout: StdoutSink;
  private readonly platform: string;

  constructor(
    executor: CommandExecutor = makeSpawnExecutor(),
    stdout: StdoutSink = makeProcessStdout(),
    platform: string = process.platform
  ) {
    this.executor = executor;
    this.stdout = stdout;
    this.platform = platform;
  }

  bell(): void {
    this.stdout.write("\x07");
  }

  notify(title: string, body: string): void {
    if (this.platform === "darwin") {
      // Escape any double-quotes in title/body to prevent osascript injection.
      const safeTitle = title.replace(/"/g, '\\"');
      const safeBody = body.replace(/"/g, '\\"');
      this.executor.exec("osascript", [
        "-e",
        `display notification "${safeBody}" with title "${safeTitle}"`,
      ]);
    } else {
      // Non-darwin: log only so callers get consistent behavior without
      // any platform-specific machinery.
      console.log(`[notify] ${title}: ${body}`);
    }
  }
}
