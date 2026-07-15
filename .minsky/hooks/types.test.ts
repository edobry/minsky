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
import {
  emitHookFiredOnDeny,
  writeOutput,
  execSync,
  execWithPath,
  resolveGitBinary,
} from "./types";

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

/**
 * resolveGitBinary / execSync / execWithPath crash-safety tests (mt#2810).
 *
 * Covers the two independent fixes documented in the module comment above
 * `safeSpawnSync` in types.ts:
 *   1. `Bun.spawnSync` throwing ENOENT is caught, never propagates.
 *   2. `resolveGitBinary` resolves an absolute git path via `Bun.which` then
 *      a filesystem-existence fallback list, independent of whether the
 *      spawn environment's PATH happens to contain it.
 */
describe("resolveGitBinary (mt#2810)", () => {
  test("returns Bun.which's result when it resolves", () => {
    const resolved = resolveGitBinary({
      noCache: true,
      whichFn: () => "/custom/path/to/git",
    });
    expect(resolved).toBe("/custom/path/to/git");
  });

  test("falls through to the fallback candidate list when Bun.which fails", () => {
    const resolved = resolveGitBinary({
      noCache: true,
      whichFn: () => null,
      fallbackPaths: ["/does/not/exist/git", "/also/missing/git", "/found/it/git"],
      existsSyncFn: (p) => p === "/found/it/git",
    });
    expect(resolved).toBe("/found/it/git");
  });

  test("returns bare 'git' when neither Bun.which nor any fallback resolves", () => {
    const resolved = resolveGitBinary({
      noCache: true,
      whichFn: () => null,
      fallbackPaths: ["/does/not/exist/git"],
      existsSyncFn: () => false,
    });
    expect(resolved).toBe("git");
  });

  test("a throwing whichFn is treated the same as 'not found' — falls through to fallbacks", () => {
    const resolved = resolveGitBinary({
      noCache: true,
      whichFn: () => {
        throw new Error("which boom");
      },
      fallbackPaths: ["/fallback/git"],
      existsSyncFn: (p) => p === "/fallback/git",
    });
    expect(resolved).toBe("/fallback/git");
  });

  test("a throwing existsSyncFn is treated as 'not found' for that candidate — keeps scanning", () => {
    const resolved = resolveGitBinary({
      noCache: true,
      whichFn: () => null,
      fallbackPaths: ["/throws/git", "/ok/git"],
      existsSyncFn: (p) => {
        if (p === "/throws/git") throw new Error("existsSync boom");
        return p === "/ok/git";
      },
    });
    expect(resolved).toBe("/ok/git");
  });

  test("noCache:true bypasses the module cache — each call re-resolves independently", () => {
    let calls = 0;
    const whichFn = () => {
      calls++;
      return `/cached/git/${calls}`;
    };
    // noCache:true never reads OR writes the module-level cache, so two
    // noCache:true calls each re-invoke whichFn and can return different
    // values — proving this option genuinely bypasses caching (as opposed
    // to a default call, which is expected to cache for the process
    // lifetime; that default-path behavior isn't asserted here since it
    // would depend on the module cache's ambient state from other tests/
    // production code paths in the same process).
    const first = resolveGitBinary({ noCache: true, whichFn });
    const second = resolveGitBinary({ noCache: true, whichFn });
    expect(calls).toBe(2);
    expect(first).not.toBe(second);
  });
});

describe("execWithPath / execSync spawn-failure safety (mt#2810)", () => {
  /** The exact message Bun.spawnSync throws on a real ENOENT (verified empirically —
   * see the module comment above `safeSpawnSync` in types.ts). Shared across this
   * describe block's tests to avoid magic-string duplication. */
  const ENOENT_GIT_ERROR_MESSAGE = 'Executable not found in $PATH: "git"';

  afterEach(() => {
    // @ts-expect-error — restore any spy installed by a test
    if (Bun.spawnSync.mockRestore)
      (Bun.spawnSync as unknown as { mockRestore: () => void }).mockRestore();
    // @ts-expect-error — restore console.error if spied
    if (console.error.mockRestore)
      (console.error as unknown as { mockRestore: () => void }).mockRestore();
  });

  test("execWithPath never throws when Bun.spawnSync throws ENOENT", () => {
    spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error(ENOENT_GIT_ERROR_MESSAGE);
    });
    spyOn(console, "error").mockImplementation(() => {});
    expect(() => execWithPath(["git", "status"])).not.toThrow();
  });

  test("execWithPath returns a structured non-zero ExecResult instead of throwing", () => {
    spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error(ENOENT_GIT_ERROR_MESSAGE);
    });
    spyOn(console, "error").mockImplementation(() => {});
    const result = execWithPath(["git", "status"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("spawn failed");
    expect(result.timedOut).toBe(false);
  });

  test("execWithPath logs a loud structured degradation warning naming the failed command", () => {
    spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error(ENOENT_GIT_ERROR_MESSAGE);
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    execWithPath(["git", "remote", "get-url", "origin"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = errorSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain("[hook-exec] DEGRADED");
    expect(message).toContain("git remote get-url origin");
    expect(message).not.toContain("undefined");
  });

  test("execSync never throws when Bun.spawnSync throws ENOENT", () => {
    spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error(ENOENT_GIT_ERROR_MESSAGE);
    });
    spyOn(console, "error").mockImplementation(() => {});
    expect(() => execSync(["git", "rev-parse", "HEAD"])).not.toThrow();
    const result = execSync(["git", "rev-parse", "HEAD"]);
    expect(result.exitCode).toBe(127);
  });

  test("a non-ENOENT spawn success still passes through normally (no regression)", () => {
    spyOn(Bun, "spawnSync").mockImplementation(
      () =>
        ({
          exitCode: 0,
          stdout: Buffer.from("hello\n"),
          stderr: Buffer.from(""),
          signalCode: null,
        }) as never
    );
    const result = execWithPath(["gh", "pr", "view"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  test("execWithPath resolves git to an absolute path even when process.env.PATH is broken", () => {
    // Real (unmocked) Bun.spawnSync + real filesystem — exercises the actual
    // resolution path end-to-end. Every dev/CI machine that can run this
    // test suite at all has SOME git binary, so this proves the augmented
    // resolution (Bun.which + fallback list) finds it regardless of PATH.
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/mt2810-nonexistent-path-for-testing";
      const result = execWithPath(["git", "--version"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("git version");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
