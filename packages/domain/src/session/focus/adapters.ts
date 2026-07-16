/**
 * Per-emulator focus adapters (mt#2285).
 *
 * Each adapter matches on the `terminalContext` signal(s) mt#2284 captures
 * and issues its emulator-specific focus command(s) through the injected
 * `CommandExecutor` seam -- never a raw `Bun.spawn` call. See `./types.ts`
 * for the hard sandbox constraint this seam exists to satisfy.
 */
import { isAppleScriptPermissionError, appleScriptPermissionMessage } from "./executor";
import type { CommandExecResult, CommandExecutor, FocusAdapter, FocusOutcome } from "./types";

/**
 * Format an external-command failure for display, distinguishing a
 * spawn-time failure (binary missing/not on PATH -- `result.spawnError`) from
 * a process that started and exited non-zero (R1 review finding, mt#2285:
 * these two failure classes were previously conflated, so a missing `wezterm`
 * binary read as an in-app wezterm error).
 */
function formatExecError(result: CommandExecResult, toolName: string): string {
  if (result.spawnError) {
    return (
      `${toolName} could not be started (${result.stderr.trim() || "unknown error"}) -- ` +
      `ensure ${toolName} is installed and on PATH`
    );
  }
  return result.stderr.trim() || `unknown ${toolName} error`;
}

// ---------------------------------------------------------------------------
// tmux -- best tier: programmatic, no GUI permissions.
// ---------------------------------------------------------------------------

export const tmuxFocusAdapter: FocusAdapter = {
  name: "tmux",
  matches: (ctx) => Boolean(ctx.terminalContext.TMUX_PANE),
  async focus(ctx, executor) {
    const pane = ctx.terminalContext.TMUX_PANE as string;

    // select-window is server-side and works regardless of whether this
    // process is itself an attached tmux client.
    const selectWindow = await executor(["tmux", "select-window", "-t", pane]);
    if (selectWindow.exitCode !== 0) {
      return {
        kind: "error",
        adapter: "tmux",
        message:
          `Could not select the tmux window for pane ${pane}: ` +
          `${formatExecError(selectWindow, "tmux")}. Run \`tmux select-window -t ${pane}\` manually.`,
      };
    }

    // switch-client re-displays the pane on the client running this command;
    // it can legitimately fail if this process isn't itself an attached
    // client (e.g. invoked from a non-tmux shell).
    const switchClient = await executor(["tmux", "switch-client", "-t", pane]);
    if (switchClient.exitCode === 0) {
      return {
        kind: "focused",
        adapter: "tmux",
        message: `Selected and switched the attached tmux client to pane ${pane}.`,
      };
    }

    // The pane's window is now active in ITS session, but nothing was
    // actually displayed for the operator -- this is NOT the same as
    // degraded-app-raised (which does bring a real window to front), so it
    // gets its own kind (R1 review finding, mt#2285).
    //
    // `tmux attach -t <pane>` is not a valid remediation: `attach` requires a
    // SESSION target, not a pane id. Resolve the pane's owning session name
    // so the suggested command is actually runnable.
    const sessionLookup = await executor(["tmux", "display-message", "-p", "-t", pane, "#S"]);
    const sessionName = sessionLookup.exitCode === 0 ? sessionLookup.stdout.trim() : undefined;
    const attachHint = sessionName
      ? `Run \`tmux attach -t ${sessionName}\` to view it.`
      : `Run \`tmux list-panes -a\` to find which session owns pane ${pane}, then ` +
        "`tmux attach -t <that session>`.";

    return {
      kind: "degraded-selected-only",
      adapter: "tmux",
      message:
        `Selected the window for pane ${pane} in its tmux session, but could not switch a ` +
        `client display to it: ${formatExecError(switchClient, "tmux")}. ${attachHint}`,
    };
  },
};

// ---------------------------------------------------------------------------
// WezTerm
// ---------------------------------------------------------------------------

export const weztermFocusAdapter: FocusAdapter = {
  name: "WezTerm",
  matches: (ctx) => Boolean(ctx.terminalContext.WEZTERM_PANE),
  async focus(ctx, executor) {
    const paneId = ctx.terminalContext.WEZTERM_PANE as string;
    const result = await executor(["wezterm", "cli", "activate-pane", "--pane-id", paneId]);
    if (result.exitCode === 0) {
      return {
        kind: "focused",
        adapter: "WezTerm",
        message: `Activated WezTerm pane ${paneId}.`,
      };
    }
    return {
      kind: "error",
      adapter: "WezTerm",
      message:
        `Could not activate WezTerm pane ${paneId}: ${formatExecError(result, "wezterm")}. ` +
        `Run \`wezterm cli activate-pane --pane-id ${paneId}\` manually.`,
    };
  },
};

// ---------------------------------------------------------------------------
// kitty
// ---------------------------------------------------------------------------

export const kittyFocusAdapter: FocusAdapter = {
  name: "kitty",
  matches: (ctx) => Boolean(ctx.terminalContext.KITTY_WINDOW_ID),
  async focus(ctx, executor) {
    const windowId = ctx.terminalContext.KITTY_WINDOW_ID as string;
    const result = await executor(["kitty", "@", "focus-window", "--match", `id:${windowId}`]);
    if (result.exitCode === 0) {
      return {
        kind: "focused",
        adapter: "kitty",
        message: `Focused kitty window ${windowId}.`,
      };
    }
    // Only suggest the remote-control-disabled fix when the binary actually
    // ran and failed -- a missing kitty binary isn't a remote-control config
    // problem, and formatExecError already names that case.
    const remoteControlHint = result.spawnError
      ? ""
      : " kitty remote control must be enabled (allow_remote_control in kitty.conf) for " +
        "this to work.";
    return {
      kind: "error",
      adapter: "kitty",
      message:
        `Could not focus kitty window ${windowId}: ${formatExecError(result, "kitty")}.` +
        `${remoteControlHint} Run \`kitty @ focus-window --match id:${windowId}\` manually.`,
    };
  },
};

// ---------------------------------------------------------------------------
// iTerm2 -- AppleScript, needs macOS Automation permission.
// ---------------------------------------------------------------------------

/**
 * Escape a value for embedding in an AppleScript double-quoted string
 * literal. Handles backslash and quote (the base case), then CR/LF/TAB
 * (which would otherwise break out of the string literal onto a new source
 * line), then strips any other remaining raw control bytes (NUL, BEL, ESC,
 * etc.) that AppleScript's parser cannot represent inside a string literal at
 * all. Order matters: CR/LF/TAB are turned into two-character escape
 * sequences BEFORE the final control-character strip, so that strip only
 * touches bytes we haven't already handled (R1 review finding, mt#2285: the
 * prior version only escaped backslash/quote, so an embedded newline in
 * TERM_SESSION_ID or tty -- both ultimately environment/filesystem-derived,
 * effectively untrusted -- would corrupt the generated script).
 */
function escapeForAppleScriptString(value: string): string {
  return (
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")
      // eslint-disable-next-line no-control-regex -- deliberately strips any remaining raw control bytes (NUL, BEL, ESC, DEL) left after CR/LF/TAB were escaped above
      .replace(/[\x00-\x1f\x7f]/g, "")
  );
}

function buildITerm2ActivateScript(sessionId: string): string {
  const escaped = escapeForAppleScriptString(sessionId);
  return (
    'tell application "iTerm2"\n' +
    "  activate\n" +
    "  repeat with w in windows\n" +
    "    repeat with t in tabs of w\n" +
    "      repeat with s in sessions of t\n" +
    `        if id of s is "${escaped}" then\n` +
    "          select t\n" +
    "          select s\n" +
    "          return\n" +
    "        end if\n" +
    "      end repeat\n" +
    "    end repeat\n" +
    "  end repeat\n" +
    "end tell"
  );
}

async function runAppleScript(executor: CommandExecutor, script: string) {
  return executor(["osascript", "-e", script]);
}

export const iterm2FocusAdapter: FocusAdapter = {
  name: "iTerm2",
  matches: (ctx) =>
    ctx.terminalContext.TERM_PROGRAM === "iTerm.app" &&
    Boolean(ctx.terminalContext.TERM_SESSION_ID),
  async focus(ctx, executor) {
    const sessionId = ctx.terminalContext.TERM_SESSION_ID as string;
    const script = buildITerm2ActivateScript(sessionId);
    const result = await runAppleScript(executor, script);

    if (result.exitCode === 0) {
      return {
        kind: "focused",
        adapter: "iTerm2",
        message: `Raised iTerm2 and selected the tab for session ${sessionId}.`,
      };
    }
    if (isAppleScriptPermissionError(result)) {
      return {
        kind: "permission-denied",
        adapter: "iTerm2",
        message: appleScriptPermissionMessage("iTerm2"),
      };
    }
    return {
      kind: "error",
      adapter: "iTerm2",
      message: `Could not raise the iTerm2 tab for session ${sessionId}: ${formatExecError(result, "osascript")}.`,
    };
  },
};

// ---------------------------------------------------------------------------
// Terminal.app -- AppleScript, needs macOS Automation permission. Matched by
// tty (Terminal.app's AppleScript dictionary exposes `tty of tab`, but has no
// property matching TERM_SESSION_ID directly).
// ---------------------------------------------------------------------------

function buildTerminalAppActivateScript(tty: string): string {
  const escaped = escapeForAppleScriptString(tty);
  return (
    'tell application "Terminal"\n' +
    "  activate\n" +
    "  repeat with w in windows\n" +
    "    repeat with t in tabs of w\n" +
    `      if tty of t is "${escaped}" then\n` +
    "        set selected of t to true\n" +
    "        set index of w to 1\n" +
    "        return\n" +
    "      end if\n" +
    "    end repeat\n" +
    "  end repeat\n" +
    "end tell"
  );
}

export const terminalAppFocusAdapter: FocusAdapter = {
  name: "Terminal.app",
  matches: (ctx) => ctx.terminalContext.TERM_PROGRAM === "Apple_Terminal" && Boolean(ctx.tty),
  async focus(ctx, executor) {
    const tty = ctx.tty as string;
    const script = buildTerminalAppActivateScript(tty);
    const result = await runAppleScript(executor, script);

    if (result.exitCode === 0) {
      return {
        kind: "focused",
        adapter: "Terminal.app",
        message: `Raised Terminal.app and selected the tab for tty ${tty}.`,
      };
    }
    if (isAppleScriptPermissionError(result)) {
      return {
        kind: "permission-denied",
        adapter: "Terminal.app",
        message: appleScriptPermissionMessage("Terminal"),
      };
    }
    return {
      kind: "error",
      adapter: "Terminal.app",
      message: `Could not raise the Terminal.app tab for tty ${tty}: ${formatExecError(result, "osascript")}.`,
    };
  },
};

// ---------------------------------------------------------------------------
// WM-raise degraded fallback -- Alacritty, Ghostty, or any unrecognized
// TERM_PROGRAM. Uses `open -a` (Launch Services), not AppleScript `activate`,
// so it needs no Automation permission -- it's a plain app-focus request.
// ---------------------------------------------------------------------------

const TERM_PROGRAM_APP_NAMES: Record<string, string> = {
  "iTerm.app": "iTerm",
  Apple_Terminal: "Terminal",
  WezTerm: "WezTerm",
  ghostty: "Ghostty",
  vscode: "Visual Studio Code",
};

export function resolveAppNameForTermProgram(termProgram: string): string {
  return TERM_PROGRAM_APP_NAMES[termProgram] ?? termProgram;
}

export const wmRaiseFocusAdapter: FocusAdapter = {
  name: "wm-raise",
  matches: (ctx) => Boolean(ctx.terminalContext.TERM_PROGRAM),
  async focus(ctx, executor): Promise<FocusOutcome> {
    const termProgram = ctx.terminalContext.TERM_PROGRAM as string;
    const appName = resolveAppNameForTermProgram(termProgram);
    const result = await executor(["open", "-a", appName]);

    if (result.exitCode === 0) {
      return {
        kind: "degraded-app-raised",
        adapter: "wm-raise",
        message:
          `${appName} has no per-tab focus API here; raised the application window ` +
          "instead. Navigate to the right tab/pane manually.",
      };
    }
    return {
      kind: "error",
      adapter: "wm-raise",
      message:
        `Could not raise ${appName}: ${formatExecError(result, "open")}. ` +
        "Bring it to the foreground manually.",
    };
  },
};
