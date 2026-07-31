/**
 * Tests for the focus-adapter registry + orchestration (mt#2285).
 *
 * All executor calls are mocked -- no real tmux/wezterm/kitty/AppleScript
 * invocation ever runs here, per the task's hard sandbox constraint.
 */
import { describe, test, expect, mock } from "bun:test";
import { resolveFocusAdapter, focusAttachment, FOCUS_ADAPTER_REGISTRY } from "./registry";
import type { CommandExecResult, CommandExecutor } from "./types";

function ok(): CommandExecResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

describe("resolveFocusAdapter", () => {
  test("prefers tmux over iTerm2 when both signals are present", () => {
    const adapter = resolveFocusAdapter({
      terminalContext: {
        TMUX_PANE: "%3",
        TERM_PROGRAM: "iTerm.app",
        TERM_SESSION_ID: "w0t0p0:ABC",
      },
    });
    expect(adapter?.name).toBe("tmux");
  });

  test("selects WezTerm when only WEZTERM_PANE is present", () => {
    const adapter = resolveFocusAdapter({ terminalContext: { WEZTERM_PANE: "3" } });
    expect(adapter?.name).toBe("WezTerm");
  });

  test("selects kitty when only KITTY_WINDOW_ID is present", () => {
    const adapter = resolveFocusAdapter({ terminalContext: { KITTY_WINDOW_ID: "3" } });
    expect(adapter?.name).toBe("kitty");
  });

  test("selects iTerm2 when TERM_PROGRAM/TERM_SESSION_ID match and nothing more specific is present", () => {
    const adapter = resolveFocusAdapter({
      terminalContext: { TERM_PROGRAM: "iTerm.app", TERM_SESSION_ID: "w0t0p0:ABC" },
    });
    expect(adapter?.name).toBe("iTerm2");
  });

  test("selects Terminal.app when TERM_PROGRAM is Apple_Terminal and tty is present", () => {
    const adapter = resolveFocusAdapter({
      terminalContext: { TERM_PROGRAM: "Apple_Terminal" },
      tty: "/dev/ttys003",
    });
    expect(adapter?.name).toBe("Terminal.app");
  });

  test("falls back to wm-raise for an unrecognized TERM_PROGRAM", () => {
    const adapter = resolveFocusAdapter({ terminalContext: { TERM_PROGRAM: "Alacritty" } });
    expect(adapter?.name).toBe("wm-raise");
  });

  test("returns undefined when no signal is present at all", () => {
    const adapter = resolveFocusAdapter({ terminalContext: {} });
    expect(adapter).toBeUndefined();
  });

  test("the default registry contains exactly the 6 documented adapters in precedence order", () => {
    expect(FOCUS_ADAPTER_REGISTRY.map((a) => a.name)).toEqual([
      "tmux",
      "WezTerm",
      "kitty",
      "iTerm2",
      "Terminal.app",
      "wm-raise",
    ]);
  });
});

describe("focusAttachment", () => {
  test("returns no-signal with a handle-only message when nothing matches", async () => {
    const executor: CommandExecutor = mock(async () => ok());
    const result = await focusAttachment(
      { terminalContext: {}, pid: 4242, tty: "/dev/ttysXYZ" },
      { executor }
    );
    expect(result.kind).toBe("no-signal");
    expect(result.message).toContain("pid 4242");
    expect(result.message).toContain("tty /dev/ttysXYZ");
    expect(executor).not.toHaveBeenCalled();
  });

  test("returns no-signal with no handle parenthetical when pid/tty are both absent", async () => {
    const result = await focusAttachment({ terminalContext: {} });
    expect(result.kind).toBe("no-signal");
    expect(result.message).not.toContain("pid");
    expect(result.message).not.toContain("tty");
  });

  test("delegates to the matched adapter and passes through its outcome", async () => {
    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return ok();
    });
    const result = await focusAttachment({ terminalContext: { TMUX_PANE: "%7" } }, { executor });
    expect(result.kind).toBe("focused");
    expect(result.adapter).toBe("tmux");
    expect(calls[0]).toEqual(["tmux", "select-window", "-t", "%7"]);
  });

  test("supports an injected registry override (e.g. a test double adapter)", async () => {
    const fakeAdapter = {
      name: "fake",
      matches: () => true,
      focus: async () => ({ kind: "focused" as const, adapter: "fake", message: "faked" }),
    };
    const result = await focusAttachment(
      { terminalContext: { TERM_PROGRAM: "anything" } },
      { registry: [fakeAdapter] }
    );
    expect(result).toEqual({ kind: "focused", adapter: "fake", message: "faked" });
  });
});
