/**
 * Tests for per-emulator focus adapters (mt#2285).
 *
 * HARD sandbox constraint: no real AppleScript, tmux, wezterm, or kitty
 * invocation ever runs here -- every test injects a mock `CommandExecutor`
 * and asserts on the argv it was called with plus the outcome the adapter
 * derives from a canned CommandExecResult.
 */
import { describe, test, expect, mock } from "bun:test";
import {
  tmuxFocusAdapter,
  weztermFocusAdapter,
  kittyFocusAdapter,
  iterm2FocusAdapter,
  terminalAppFocusAdapter,
  wmRaiseFocusAdapter,
  resolveAppNameForTermProgram,
} from "./adapters";
import type { CommandExecResult, CommandExecutor, FocusAdapterContext } from "./types";

function ok(stdout = ""): CommandExecResult {
  return { exitCode: 0, stdout, stderr: "" };
}
function fail(stderr = "boom"): CommandExecResult {
  return { exitCode: 1, stdout: "", stderr };
}
function spawnFail(stderr = "command not found: x"): CommandExecResult {
  return { exitCode: 1, stdout: "", stderr, spawnError: true };
}
/** Shared fragment asserted across the spawn-error tests below (avoids magic-string duplication). */
const INSTALLED_ON_PATH_HINT = "installed and on PATH";

describe("tmuxFocusAdapter", () => {
  test("matches only when TMUX_PANE is present", () => {
    expect(tmuxFocusAdapter.matches({ terminalContext: { TMUX_PANE: "%3" } })).toBe(true);
    expect(tmuxFocusAdapter.matches({ terminalContext: {} })).toBe(false);
  });

  test("focused: select-window and switch-client both succeed", async () => {
    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return ok();
    });
    const ctx: FocusAdapterContext = { terminalContext: { TMUX_PANE: "%3" } };
    const outcome = await tmuxFocusAdapter.focus(ctx, executor);

    expect(outcome.kind).toBe("focused");
    expect(calls).toEqual([
      ["tmux", "select-window", "-t", "%3"],
      ["tmux", "switch-client", "-t", "%3"],
    ]);
  });

  test("degraded-selected-only: select-window succeeds, switch-client fails, session name resolved", async () => {
    const calls: string[][] = [];
    let call = 0;
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      call += 1;
      if (call === 1) return ok(); // select-window
      if (call === 2) return fail("no client"); // switch-client
      return ok("mysession\n"); // display-message -p -t %3 "#S"
    });
    const outcome = await tmuxFocusAdapter.focus(
      { terminalContext: { TMUX_PANE: "%3" } },
      executor
    );
    expect(outcome.kind).toBe("degraded-selected-only");
    // Must suggest a valid SESSION target, never the pane id itself (attach -t
    // expects a session, not a pane -- R1 review finding).
    expect(outcome.message).toContain("tmux attach -t mysession");
    expect(outcome.message).not.toContain("attach -t %3");
    expect(calls[2]).toEqual(["tmux", "display-message", "-p", "-t", "%3", "#S"]);
  });

  test("degraded-selected-only: falls back to a list-panes hint when the session lookup also fails", async () => {
    let call = 0;
    const executor: CommandExecutor = mock(async () => {
      call += 1;
      if (call === 1) return ok();
      if (call === 2) return fail("no client");
      return fail("no such pane"); // display-message lookup fails too
    });
    const outcome = await tmuxFocusAdapter.focus(
      { terminalContext: { TMUX_PANE: "%3" } },
      executor
    );
    expect(outcome.kind).toBe("degraded-selected-only");
    expect(outcome.message).toContain("tmux list-panes -a");
    expect(outcome.message).not.toContain("attach -t %3");
  });

  test("error: select-window fails", async () => {
    const executor: CommandExecutor = mock(async () => fail("no such pane"));
    const outcome = await tmuxFocusAdapter.focus(
      { terminalContext: { TMUX_PANE: "%9" } },
      executor
    );
    expect(outcome.kind).toBe("error");
    expect(outcome.message).toContain("no such pane");
  });

  test("error: select-window fails because tmux itself is not installed", async () => {
    const executor: CommandExecutor = mock(async () => spawnFail("command not found: tmux"));
    const outcome = await tmuxFocusAdapter.focus(
      { terminalContext: { TMUX_PANE: "%9" } },
      executor
    );
    expect(outcome.kind).toBe("error");
    expect(outcome.message).toContain(INSTALLED_ON_PATH_HINT);
  });
});

describe("weztermFocusAdapter", () => {
  test("matches only when WEZTERM_PANE is present", () => {
    expect(weztermFocusAdapter.matches({ terminalContext: { WEZTERM_PANE: "5" } })).toBe(true);
    expect(weztermFocusAdapter.matches({ terminalContext: {} })).toBe(false);
  });

  test("focused: activate-pane succeeds", async () => {
    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return ok();
    });
    const outcome = await weztermFocusAdapter.focus(
      { terminalContext: { WEZTERM_PANE: "5" } },
      executor
    );
    expect(outcome.kind).toBe("focused");
    expect(calls).toEqual([["wezterm", "cli", "activate-pane", "--pane-id", "5"]]);
  });

  test("error: activate-pane fails", async () => {
    const executor: CommandExecutor = mock(async () => fail("pane not found"));
    const outcome = await weztermFocusAdapter.focus(
      { terminalContext: { WEZTERM_PANE: "5" } },
      executor
    );
    expect(outcome.kind).toBe("error");
    expect(outcome.message).toContain("pane not found");
  });

  test("error: wezterm binary is missing (spawn error) surfaces an install hint, not a raw error", async () => {
    const executor: CommandExecutor = mock(async () => spawnFail("command not found: wezterm"));
    const outcome = await weztermFocusAdapter.focus(
      { terminalContext: { WEZTERM_PANE: "5" } },
      executor
    );
    expect(outcome.kind).toBe("error");
    expect(outcome.message).toContain(INSTALLED_ON_PATH_HINT);
  });
});

describe("kittyFocusAdapter", () => {
  test("matches only when KITTY_WINDOW_ID is present", () => {
    expect(kittyFocusAdapter.matches({ terminalContext: { KITTY_WINDOW_ID: "1" } })).toBe(true);
    expect(kittyFocusAdapter.matches({ terminalContext: {} })).toBe(false);
  });

  test("focused: focus-window succeeds", async () => {
    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return ok();
    });
    const outcome = await kittyFocusAdapter.focus(
      { terminalContext: { KITTY_WINDOW_ID: "1" } },
      executor
    );
    expect(outcome.kind).toBe("focused");
    expect(calls).toEqual([["kitty", "@", "focus-window", "--match", "id:1"]]);
  });

  test("error: focus-window fails (e.g. remote control disabled)", async () => {
    const executor: CommandExecutor = mock(async () => fail("remote control is disabled"));
    const outcome = await kittyFocusAdapter.focus(
      { terminalContext: { KITTY_WINDOW_ID: "1" } },
      executor
    );
    expect(outcome.kind).toBe("error");
    expect(outcome.message).toContain("allow_remote_control");
  });

  test("error: kitty binary is missing (spawn error) does not suggest the remote-control fix", async () => {
    const executor: CommandExecutor = mock(async () => spawnFail("command not found: kitty"));
    const outcome = await kittyFocusAdapter.focus(
      { terminalContext: { KITTY_WINDOW_ID: "1" } },
      executor
    );
    expect(outcome.kind).toBe("error");
    expect(outcome.message).toContain(INSTALLED_ON_PATH_HINT);
    expect(outcome.message).not.toContain("allow_remote_control");
  });
});

describe("iterm2FocusAdapter", () => {
  test("matches only when TERM_PROGRAM is iTerm.app AND TERM_SESSION_ID is present", () => {
    expect(
      iterm2FocusAdapter.matches({
        terminalContext: { TERM_PROGRAM: "iTerm.app", TERM_SESSION_ID: "w0t0p0:ABC" },
      })
    ).toBe(true);
    expect(iterm2FocusAdapter.matches({ terminalContext: { TERM_PROGRAM: "iTerm.app" } })).toBe(
      false
    );
    expect(
      iterm2FocusAdapter.matches({
        terminalContext: { TERM_PROGRAM: "Apple_Terminal", TERM_SESSION_ID: "w0t0p0:ABC" },
      })
    ).toBe(false);
  });

  test("focused: osascript succeeds", async () => {
    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return ok();
    });
    const outcome = await iterm2FocusAdapter.focus(
      { terminalContext: { TERM_PROGRAM: "iTerm.app", TERM_SESSION_ID: "w0t0p0:ABC" } },
      executor
    );
    expect(outcome.kind).toBe("focused");
    expect(calls[0]?.[0]).toBe("osascript");
    expect(calls[0]?.[1]).toBe("-e");
    expect(calls[0]?.[2]).toContain('id of s is "w0t0p0:ABC"');
  });

  test("hardens the generated script against a session id containing a quote, backslash, and newline", async () => {
    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return ok();
    });
    const hostileSessionId = 'w0t0p0:AB"C\\D\nE';
    await iterm2FocusAdapter.focus(
      { terminalContext: { TERM_PROGRAM: "iTerm.app", TERM_SESSION_ID: hostileSessionId } },
      executor
    );
    const script = calls[0]?.[2] ?? "";
    // The escaped script must not contain a raw double-quote inside the
    // string literal (other than the literal's own delimiters) or a raw
    // newline breaking the `if id of s is "..."` line onto multiple lines.
    const targetLine = script.split("\n").find((line) => line.includes("id of s is"));
    expect(targetLine).toBeDefined();
    expect(targetLine).toContain('\\"C\\\\D\\nE');
  });

  test("permission-denied: osascript fails with -1743", async () => {
    const executor: CommandExecutor = mock(async () =>
      fail("execution error: Not authorized to send Apple events to iTerm2. (-1743)")
    );
    const outcome = await iterm2FocusAdapter.focus(
      { terminalContext: { TERM_PROGRAM: "iTerm.app", TERM_SESSION_ID: "w0t0p0:ABC" } },
      executor
    );
    expect(outcome.kind).toBe("permission-denied");
    expect(outcome.message).toContain("Automation");
  });

  test("error: osascript fails with an unrelated error", async () => {
    const executor: CommandExecutor = mock(async () => fail("some other applescript failure"));
    const outcome = await iterm2FocusAdapter.focus(
      { terminalContext: { TERM_PROGRAM: "iTerm.app", TERM_SESSION_ID: "w0t0p0:ABC" } },
      executor
    );
    expect(outcome.kind).toBe("error");
    expect(outcome.message).toContain("some other applescript failure");
  });
});

describe("terminalAppFocusAdapter", () => {
  test("matches only when TERM_PROGRAM is Apple_Terminal AND tty is present", () => {
    expect(
      terminalAppFocusAdapter.matches({
        terminalContext: { TERM_PROGRAM: "Apple_Terminal" },
        tty: "/dev/ttys003",
      })
    ).toBe(true);
    expect(
      terminalAppFocusAdapter.matches({ terminalContext: { TERM_PROGRAM: "Apple_Terminal" } })
    ).toBe(false);
  });

  test("focused: osascript succeeds", async () => {
    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return ok();
    });
    const outcome = await terminalAppFocusAdapter.focus(
      { terminalContext: { TERM_PROGRAM: "Apple_Terminal" }, tty: "/dev/ttys003" },
      executor
    );
    expect(outcome.kind).toBe("focused");
    expect(calls[0]?.[2]).toContain('tty of t is "/dev/ttys003"');
  });

  test("hardens the generated script against a tty value containing control characters", async () => {
    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return ok();
    });
    await terminalAppFocusAdapter.focus(
      { terminalContext: { TERM_PROGRAM: "Apple_Terminal" }, tty: "/dev/ttys003\r\n\x00" },
      executor
    );
    const script = calls[0]?.[2] ?? "";
    const targetLine = script.split("\n").find((line) => line.includes("tty of t is"));
    expect(targetLine).toBeDefined();
    expect(targetLine).toContain("/dev/ttys003\\r\\n");
    // The stray NUL byte must be stripped, not passed through raw.
    // eslint-disable-next-line no-control-regex -- asserting the control byte is ABSENT
    expect(/[\x00-\x1f\x7f]/.test(targetLine ?? "")).toBe(false);
  });

  test("permission-denied: osascript fails with the Apple-events message text", async () => {
    const executor: CommandExecutor = mock(async () =>
      fail("Not authorized to send Apple events to Terminal.")
    );
    const outcome = await terminalAppFocusAdapter.focus(
      { terminalContext: { TERM_PROGRAM: "Apple_Terminal" }, tty: "/dev/ttys003" },
      executor
    );
    expect(outcome.kind).toBe("permission-denied");
  });
});

describe("resolveAppNameForTermProgram", () => {
  test("maps known TERM_PROGRAM values to their app names", () => {
    expect(resolveAppNameForTermProgram("iTerm.app")).toBe("iTerm");
    expect(resolveAppNameForTermProgram("Apple_Terminal")).toBe("Terminal");
    expect(resolveAppNameForTermProgram("WezTerm")).toBe("WezTerm");
  });

  test("falls back to the raw value for an unmapped TERM_PROGRAM", () => {
    expect(resolveAppNameForTermProgram("some-unknown-emulator")).toBe("some-unknown-emulator");
  });
});

describe("wmRaiseFocusAdapter", () => {
  test("matches whenever TERM_PROGRAM is present", () => {
    expect(wmRaiseFocusAdapter.matches({ terminalContext: { TERM_PROGRAM: "Alacritty" } })).toBe(
      true
    );
    expect(wmRaiseFocusAdapter.matches({ terminalContext: {} })).toBe(false);
  });

  test("degraded-app-raised: open -a succeeds", async () => {
    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return ok();
    });
    const outcome = await wmRaiseFocusAdapter.focus(
      { terminalContext: { TERM_PROGRAM: "ghostty" } },
      executor
    );
    expect(outcome.kind).toBe("degraded-app-raised");
    expect(calls).toEqual([["open", "-a", "Ghostty"]]);
    expect(outcome.message).toContain("Ghostty");
  });

  test("error: open -a fails", async () => {
    const executor: CommandExecutor = mock(async () => fail("application not found"));
    const outcome = await wmRaiseFocusAdapter.focus(
      { terminalContext: { TERM_PROGRAM: "SomeApp" } },
      executor
    );
    expect(outcome.kind).toBe("error");
    expect(outcome.message).toContain("application not found");
  });
});
