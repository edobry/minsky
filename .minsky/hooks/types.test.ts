/**
 * emitHookFiredOnDeny tests (mt#2537) — the hook.fired system-event bridge.
 *
 * `writeOutput` is the single common function every guard hook calls to emit
 * its stdout decision; `emitHookFiredOnDeny` is the fire-and-forget hook that
 * fires ONLY on a "deny" permissionDecision, spawning a detached
 * `minsky events emit hook.fired` subprocess that must never block or throw
 * back into the caller regardless of spawn success/failure.
 */
import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { emitHookFiredOnDeny, writeOutput } from "./types";

describe("emitHookFiredOnDeny (mt#2537)", () => {
  afterEach(() => {
    // @ts-expect-error — restore any spy installed by a test
    if (Bun.spawn.mockRestore) (Bun.spawn as unknown as { mockRestore: () => void }).mockRestore();
  });

  test("non-deny decisions never spawn a subprocess", () => {
    const spawnSpy = spyOn(Bun, "spawn");
    emitHookFiredOnDeny({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
    emitHookFiredOnDeny({ hookSpecificOutput: { hookEventName: "PreToolUse" } });
    emitHookFiredOnDeny({});
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test("a deny decision spawns a detached `minsky events emit hook.fired` call", () => {
    const unref = () => {};
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => ({ unref }) as never);

    emitHookFiredOnDeny({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked for testing",
      },
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [cmd, options] = spawnSpy.mock.calls[0] as [string[], Record<string, unknown>];
    expect(cmd[0]).toBe("minsky");
    expect(cmd.slice(1, 4)).toEqual(["events", "emit", "hook.fired"]);
    expect(cmd[4]).toBe("--payload");
    const payload = JSON.parse(cmd[5] as string);
    expect(payload.decision).toBe("blocked");
    expect(typeof payload.hook).toBe("string");
    // Fire-and-forget: stdio ignored, no stdin required from the parent.
    expect(options.stdout).toBe("ignore");
    expect(options.stderr).toBe("ignore");
  });

  test("a throwing Bun.spawn is swallowed — never propagates", () => {
    spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("spawn boom");
    });
    expect(() =>
      emitHookFiredOnDeny({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      })
    ).not.toThrow();
  });

  test("writeOutput still writes JSON to stdout and never throws on deny", () => {
    spyOn(Bun, "spawn").mockImplementation(() => ({ unref: () => {} }) as never);
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(() =>
      writeOutput({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      })
    ).not.toThrow();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    writeSpy.mockRestore();
  });
});
