/**
 * Per-emulator focus adapters (mt#2285).
 *
 * Each adapter matches on the `terminalContext` signal(s) mt#2284 captures
 * and issues its emulator-specific focus command(s) through the injected
 * `CommandExecutor` seam -- never a raw `Bun.spawn` call. See `./types.ts`
 * for the hard sandbox constraint this seam exists to satisfy.
 */
import { isAppleScriptPermissionError, appleScriptPermissionMessage } from "./executor";
import type { CommandExecutor, FocusAdapter, FocusOutcome } from "./types";

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
          `${selectWindow.stderr.trim() || "unknown tmux error"}. ` +
          `Run \`tmux select-window -t ${pane}\` manually.`,
      };
    }

    // switch-client re-displays the pane on the client running this command;
    // it can legitimately fail if this process isn't itself an attached
    // client (e.g. invoked from a non-tmux shell). The window is still
    // active in its session either way, so treat that as a degraded success.
    const switchClient = await executor(["tmux", "switch-client", "-t", pane]);
    if (switchClient.exitCode !== 0) {
      return {
        kind: "degraded-app-raised",
        adapter: "tmux",
        message:
          `Selected the window for pane ${pane} in its tmux session, but could not ` +
          `switch a client display to it: ${switchClient.stderr.trim() || "unknown tmux error"}. ` +
          `Run \`tmux attach -t ${pane}\` in a terminal to view it.`,
      };
    }

    return {
      kind: "focused",
      adapter: "tmux",
      message: `Selected and switched the attached tmux client to pane ${pane}.`,
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
        `Could not activate WezTerm pane ${paneId}: ` +
        `${result.stderr.trim() || "unknown wezterm error"}. ` +
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
    return {
      kind: "error",
      adapter: "kitty",
      message:
        `Could not focus kitty window ${windowId}: ` +
        `${result.stderr.trim() || "unknown kitty error"}. kitty remote control must be ` +
        `enabled (allow_remote_control in kitty.conf) for this to work. Run ` +
        `\`kitty @ focus-window --match id:${windowId}\` manually.`,
    };
  },
};

// ---------------------------------------------------------------------------
// iTerm2 -- AppleScript, needs macOS Automation permission.
// ---------------------------------------------------------------------------

function escapeForAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
      message:
        `Could not raise the iTerm2 tab for session ${sessionId}: ` +
        `${result.stderr.trim() || "unknown AppleScript error"}.`,
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
      message:
        `Could not raise the Terminal.app tab for tty ${tty}: ` +
        `${result.stderr.trim() || "unknown AppleScript error"}.`,
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
        `Could not raise ${appName}: ${result.stderr.trim() || "unknown error"}. ` +
        "Bring it to the foreground manually.",
    };
  },
};
