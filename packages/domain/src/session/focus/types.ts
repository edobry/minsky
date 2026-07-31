/**
 * Focus-adapter domain types (mt#2285).
 *
 * `session focus <id>` (alias `session goto`) raises the terminal where a
 * session's agent is running to the foreground. Focusing a specific tab/pane
 * is inherently terminal-program-specific -- there is no portable syscall for
 * it -- so the design is a strategy registry of small per-emulator adapters
 * keyed off the `terminalContext` env bag mt#2284 captures (TERM_PROGRAM,
 * TERM_SESSION_ID, TERM, TMUX, TMUX_PANE, WEZTERM_PANE, KITTY_WINDOW_ID) plus
 * the attachment's `pid`/`tty`.
 *
 * HARD sandbox constraint (task spec, 2026-07-15 reconciliation note item 3):
 * the implementation/test sandbox must never execute a real focus action --
 * no live AppleScript, no live tmux/wezterm/kitty invocations. Every adapter
 * therefore routes ALL external-program execution through the single
 * `CommandExecutor` seam below, so tests can inject a mock and production
 * wires the real one. This mirrors the `LsofRunner` injectable-seam pattern
 * already established in `../attachment-lsof.ts` for the same reason.
 */

/** Result of running a single external command through the executor seam. */
export interface CommandExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * True when the executor could not even START the process (binary missing,
   * ENOENT, permission-to-exec denied, etc.), as distinct from the process
   * starting and exiting non-zero. Adapters use this to give a "not
   * installed / not on PATH" remediation instead of misattributing a
   * spawn-time failure to the target application's own error text (R1
   * review finding, mt#2285).
   */
  spawnError?: boolean;
}

/**
 * Injectable command-executor seam. Every focus adapter -- tmux,
 * AppleScript-driven iTerm2/Terminal.app, WezTerm, kitty, and the WM-raise
 * fallback -- MUST invoke external programs exclusively through this seam.
 */
export type CommandExecutor = (argv: string[]) => Promise<CommandExecResult>;

/**
 * Context handed to a focus adapter: the terminalContext env bag mt#2284
 * captured, plus the attachment's pid/tty (also captured by mt#2284, used by
 * the Terminal.app adapter which has no way to match on TERM_SESSION_ID).
 */
export interface FocusAdapterContext {
  terminalContext: Record<string, string>;
  pid?: number;
  tty?: string;
}

/** Discriminated outcome kind for a focus attempt. */
export type FocusOutcomeKind =
  | "focused" // the adapter successfully raised the specific tab/pane
  | "degraded-app-raised" // could not target a specific tab/pane; raised the app window instead
  | "degraded-selected-only" // mutated server-side state (e.g. tmux's active window) but
  // could not actually display anything for the operator -- distinct from
  // degraded-app-raised, which DOES bring a visible window to front (R1
  // review finding, mt#2285: the prior tmux degraded path reused
  // degraded-app-raised even though nothing was raised on screen)
  | "permission-denied" // an OS-level Automation/Accessibility permission blocked the action
  | "error"; // the adapter attempted the action and it failed for another reason

export interface FocusOutcome {
  kind: FocusOutcomeKind;
  /** Human-readable, actionable message describing the outcome. Never silent. */
  message: string;
  /** Name of the adapter that produced this outcome. */
  adapter: string;
}

/** A per-emulator focus strategy. Adding an emulator means adding one of these. */
export interface FocusAdapter {
  /** Stable adapter name, surfaced in outcome messages and asserted in tests. */
  name: string;
  /** Whether this adapter's required terminalContext signal(s) are present. */
  matches(ctx: FocusAdapterContext): boolean;
  /** Perform the focus action. Only ever invoked when matches() returned true. */
  focus(ctx: FocusAdapterContext, executor: CommandExecutor): Promise<FocusOutcome>;
}
