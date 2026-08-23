/**
 * emitHookFiredOnDeny tests (mt#2537) — the hook.fired system-event bridge.
 *
 * `writeOutput` is the single common function every guard hook calls to emit
 * its stdout decision; `emitHookFiredOnDeny` is the fire-and-forget hook that
 * fires ONLY on a "deny" permissionDecision, spawning a detached
 * `minsky events emit hook.fired` subprocess that must never block or throw
 * back into the caller regardless of spawn success/failure.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- the mt#3393 default-resolution test below must read the REAL tree; injecting a mock fs there would only re-assert the injected tests
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  emitHookFiredOnDeny,
  writeOutput,
  execSync,
  execWithPath,
  resolveGitBinary,
  __resetGitBinaryCacheForTests,
  HOOK_MINSKY_CLI_PG_CONNECT_TIMEOUT_SEC,
  normalizeToolResult,
  findRepoRoot,
  deriveHookRepoRoot,
  readPositiveIntEnv,
} from "./types";
import type {
  MergeDetectFs,
  SpawnCallOptions,
  SpawnImpl,
  SpawnSyncCallOptions,
  SpawnSyncImpl,
} from "./types";
import { decideReminderFromPayload } from "./drive-pr-to-convergence";
import { isDoneTransition } from "./bridge-memory-retirement";

// ---------------------------------------------------------------------------
// Injectable spawn fakes (mt#3630)
// ---------------------------------------------------------------------------
//
// These replace the previous spy patches on `Bun.spawn` / `Bun.spawnSync`. A spy mutates
// the Bun global for the whole test-runner process and must be restored by hand — a
// missed or thrown-past restore leaks a fake spawn into every later test file. An
// injected impl is scoped to the one call that receives it, so there is nothing to
// restore and nothing to leak.

interface SpawnCall {
  cmd: string[];
  options: SpawnCallOptions;
}

/** Records every `Bun.spawn`-shaped call; optionally throws to exercise the swallow path. */
function makeSpawnRecorder(behavior?: { throws: Error }): {
  calls: SpawnCall[];
  unrefCount: () => number;
  spawnImpl: SpawnImpl;
} {
  const calls: SpawnCall[] = [];
  let unrefs = 0;
  return {
    calls,
    unrefCount: () => unrefs,
    spawnImpl: (cmd, options) => {
      calls.push({ cmd, options });
      if (behavior) throw behavior.throws;
      return {
        unref: () => {
          unrefs++;
        },
      };
    },
  };
}

interface SpawnSyncCall {
  cmd: string[];
  options: SpawnSyncCallOptions;
}

/** Records every `Bun.spawnSync`-shaped call and replays a canned result (or throws). */
function makeSpawnSyncRecorder(
  behavior: { throws: Error } | { stdout?: string; stderr?: string; exitCode?: number | null }
): { calls: SpawnSyncCall[]; spawnSyncImpl: SpawnSyncImpl } {
  const calls: SpawnSyncCall[] = [];
  return {
    calls,
    spawnSyncImpl: (cmd, options) => {
      calls.push({ cmd, options });
      if ("throws" in behavior) throw behavior.throws;
      return {
        // `?? 0` would be wrong here: `exitCode: null` is a MEANINGFUL value (the
        // killed/timed-out spawn Bun reports), not an absent one.
        exitCode: behavior.exitCode === undefined ? 0 : behavior.exitCode,
        stdout: Buffer.from(behavior.stdout ?? ""),
        stderr: Buffer.from(behavior.stderr ?? ""),
      };
    },
  };
}

/** Collects the `[hook-exec] DEGRADED` warnings instead of writing them to the console. */
function makeDegradedCollector(): { messages: string[]; onDegraded: (m: string) => void } {
  const messages: string[] = [];
  return { messages, onDegraded: (m: string) => messages.push(m) };
}

describe("emitHookFiredOnDeny (mt#2537)", () => {
  test("non-deny decisions never spawn a subprocess", () => {
    const spawn = makeSpawnRecorder();
    emitHookFiredOnDeny(
      { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } },
      { spawnImpl: spawn.spawnImpl }
    );
    emitHookFiredOnDeny(
      { hookSpecificOutput: { hookEventName: "PreToolUse" } },
      { spawnImpl: spawn.spawnImpl }
    );
    emitHookFiredOnDeny({}, { spawnImpl: spawn.spawnImpl });
    expect(spawn.calls).toHaveLength(0);
  });

  test("a deny decision spawns a detached `minsky events emit hook.fired` call", () => {
    const spawn = makeSpawnRecorder();

    emitHookFiredOnDeny(
      {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "blocked for testing",
        },
      },
      { spawnImpl: spawn.spawnImpl }
    );

    expect(spawn.calls).toHaveLength(1);
    const { cmd, options } = spawn.calls[0] as SpawnCall;
    expect(cmd[0]).toBe("minsky");
    expect(cmd.slice(1, 4)).toEqual(["events", "emit", "hook.fired"]);
    expect(cmd[4]).toBe("--payload");
    const payload = JSON.parse(cmd[5] as string);
    expect(payload.decision).toBe("blocked");
    expect(typeof payload.hook).toBe("string");
    // Fire-and-forget: stdio ignored, no stdin required from the parent, and the
    // handle is unref'd so the parent hook's exit is never blocked on it.
    expect(options.stdout).toBe("ignore");
    expect(options.stderr).toBe("ignore");
    expect(spawn.unrefCount()).toBe(1);
  });

  test("a throwing spawn impl is swallowed — never propagates", () => {
    const spawn = makeSpawnRecorder({ throws: new Error("spawn boom") });
    expect(() =>
      emitHookFiredOnDeny(
        { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } },
        { spawnImpl: spawn.spawnImpl }
      )
    ).not.toThrow();
    expect(spawn.calls).toHaveLength(1);
  });

  test("writeOutput still writes JSON to stdout and never throws on deny", () => {
    const spawn = makeSpawnRecorder();
    const written: string[] = [];
    expect(() =>
      writeOutput(
        { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } },
        {
          spawnImpl: spawn.spawnImpl,
          writeImpl: (chunk) => {
            written.push(chunk);
            return true;
          },
        }
      )
    ).not.toThrow();
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] as string)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    });
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

  test("a FAILED resolution is never cached — a later call can still succeed (mt#2810 PR #1952 R1 NON-BLOCKING)", () => {
    // Uses default (non-noCache) calls deliberately — this exercises the
    // REAL module-level cache, not the noCache-bypass path. Reset first so
    // this test is independent of whatever the shared cache's ambient state
    // happens to be from other tests/production code paths in this process.
    __resetGitBinaryCacheForTests();

    const failing = resolveGitBinary({
      whichFn: () => null,
      fallbackPaths: [],
      existsSyncFn: () => false,
    });
    expect(failing).toBe("git"); // nothing resolved — bare fallback

    // If the failed attempt had been cached, this second call would ignore
    // its own (successful) whichFn and just replay the cached bare "git".
    const RESOLVED_GIT_PATH = "/now/it/works/git";
    const succeeding = resolveGitBinary({
      whichFn: () => RESOLVED_GIT_PATH,
    });
    expect(succeeding).toBe(RESOLVED_GIT_PATH);

    // And the successful resolution DOES cache — a third call with a
    // DIFFERENT whichFn still returns the cached value, proving positive
    // resolutions are still cached as before.
    const third = resolveGitBinary({ whichFn: () => "/should/not/be/used" });
    expect(third).toBe(RESOLVED_GIT_PATH);

    __resetGitBinaryCacheForTests();
  });
});

describe("execWithPath / execSync spawn-failure safety (mt#2810)", () => {
  /** The exact message Bun.spawnSync throws on a real ENOENT (verified empirically —
   * see the module comment above `safeSpawnSync` in types.ts). Shared across this
   * describe block's tests to avoid magic-string duplication. */
  const ENOENT_GIT_ERROR_MESSAGE = 'Executable not found in $PATH: "git"';

  /** A spawn impl that throws exactly as a real ENOENT `Bun.spawnSync` does. */
  function throwingSpawnSync() {
    return makeSpawnSyncRecorder({ throws: new Error(ENOENT_GIT_ERROR_MESSAGE) });
  }

  test("execWithPath never throws when the spawn impl throws ENOENT", () => {
    const spawn = throwingSpawnSync();
    const degraded = makeDegradedCollector();
    expect(() =>
      execWithPath(["git", "status"], {
        spawnSyncImpl: spawn.spawnSyncImpl,
        onDegraded: degraded.onDegraded,
      })
    ).not.toThrow();
  });

  test("execWithPath returns a structured non-zero ExecResult instead of throwing", () => {
    const spawn = throwingSpawnSync();
    const degraded = makeDegradedCollector();
    const result = execWithPath(["git", "status"], {
      spawnSyncImpl: spawn.spawnSyncImpl,
      onDegraded: degraded.onDegraded,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("spawn failed");
    expect(result.timedOut).toBe(false);
  });

  test("execWithPath logs a loud structured degradation warning naming the failed command", () => {
    const spawn = throwingSpawnSync();
    const degraded = makeDegradedCollector();
    execWithPath(["git", "remote", "get-url", "origin"], {
      spawnSyncImpl: spawn.spawnSyncImpl,
      onDegraded: degraded.onDegraded,
    });
    expect(degraded.messages).toHaveLength(1);
    const message = degraded.messages[0] as string;
    expect(message).toContain("[hook-exec] DEGRADED");
    expect(message).toContain("git remote get-url origin");
    expect(message).not.toContain("undefined");
  });

  test("execSync never throws when the spawn impl throws ENOENT", () => {
    const degraded = makeDegradedCollector();
    const deps = {
      spawnSyncImpl: throwingSpawnSync().spawnSyncImpl,
      onDegraded: degraded.onDegraded,
    };
    expect(() => execSync(["git", "rev-parse", "HEAD"], deps)).not.toThrow();
    const result = execSync(["git", "rev-parse", "HEAD"], deps);
    expect(result.exitCode).toBe(127);
  });

  test("a non-ENOENT spawn success still passes through normally (no regression)", () => {
    const spawn = makeSpawnSyncRecorder({ exitCode: 0, stdout: "hello\n" });
    const result = execWithPath(["gh", "pr", "view"], { spawnSyncImpl: spawn.spawnSyncImpl });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  test("execWithPath's 10s timeout is a caller-overridable default; execSync sets none", () => {
    // PR #2580 R1 BLOCKING claimed mt#3630 "now forces" a 10s timeout on execWithPath.
    // Verified false positive — `?? 10000` is context in `git diff main...HEAD`, not an
    // added line. Asserted here rather than only documented, so the property is checked
    // rather than claimed: the default applies, a caller value WINS over it, and
    // execSync (the plain wrapper) still passes the caller's value through untouched.
    const withDefault = makeSpawnSyncRecorder({ exitCode: 0 });
    execWithPath(["git", "status"], { spawnSyncImpl: withDefault.spawnSyncImpl });
    expect(withDefault.calls[0]?.options.timeout).toBe(10000);

    const withOverride = makeSpawnSyncRecorder({ exitCode: 0 });
    execWithPath(["git", "status"], {
      timeout: 250,
      spawnSyncImpl: withOverride.spawnSyncImpl,
    });
    expect(withOverride.calls[0]?.options.timeout).toBe(250);

    const plain = makeSpawnSyncRecorder({ exitCode: 0 });
    execSync(["git", "status"], { spawnSyncImpl: plain.spawnSyncImpl });
    expect(plain.calls[0]?.options.timeout).toBeUndefined();
  });

  test("a null exitCode (killed/timed-out spawn) degrades to exitCode 1 + timedOut", () => {
    const spawn = makeSpawnSyncRecorder({ exitCode: null });
    const result = execWithPath(["git", "log"], { spawnSyncImpl: spawn.spawnSyncImpl });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
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

describe("execWithPath Postgres connect-timeout injection (mt#2982)", () => {
  let priorValue: string | undefined;

  beforeEach(() => {
    priorValue = process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT;
  });

  afterEach(() => {
    if (priorValue === undefined) {
      delete process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT;
    } else {
      process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT = priorValue;
    }
  });

  /** Run one `execWithPath` through an injected spawn impl and return the env it saw. */
  function envSeenBySpawn(cmd: string[]): Record<string, string | undefined> {
    const spawn = makeSpawnSyncRecorder({ exitCode: 0 });
    execWithPath(cmd, { spawnSyncImpl: spawn.spawnSyncImpl });
    return spawn.calls[0]?.options.env ?? {};
  }

  test("injects the short connect timeout into the spawn env by default", () => {
    delete process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT;
    const env = envSeenBySpawn(["minsky", "tasks", "search", "query", "--json"]);
    expect(env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT).toBe(
      HOOK_MINSKY_CLI_PG_CONNECT_TIMEOUT_SEC
    );
  });

  test("an operator-set parent-env value wins over the injected default", () => {
    process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT = "7";
    const env = envSeenBySpawn(["minsky", "tasks", "search", "query", "--json"]);
    expect(env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT).toBe("7");
  });
});

/**
 * normalizeToolResult (mt#3308) — production PostToolUse payloads carry `tool_response`,
 * never `tool_result`; the fixtures here are REAL captures (Claude Code 2.1.220,
 * 2026-07-29, recorded in the mt#3257/mt#3308 specs), per mem#672's lesson that a hook
 * whose tests hand-build the payload it claims to parse can ship dead against production.
 */
describe("normalizeToolResult", () => {
  /** REAL capture: a native-tool (Agent) payload — tool_response is a parsed object. */
  function realAgentPayload(): Record<string, unknown> {
    return {
      session_id: "902b7e22-bd44-4fa6-9590-43b80c8b8a59",
      cwd: "/mock/repo",
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { prompt: "Reply with exactly the single word ok.", model: "haiku" },
      tool_response: {
        status: "completed",
        agentId: "af3976c1820b38d69",
        agentType: "general-purpose",
        resolvedModel: "claude-haiku-4-5-20251001",
      },
    };
  }

  /** REAL capture: an MCP-tool payload — tool_response is the content envelope. */
  function realMcpPayload(): Record<string, unknown> {
    return {
      session_id: "d1f1d3bb-mock",
      cwd: "/mock/repo",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__minsky__tasks_status_get",
      tool_input: { taskId: "mt#3308" },
      tool_response: [
        {
          type: "text",
          text: '{\n  "success": true,\n  "taskId": "mt#3308",\n  "message": "Task mt#3308 status: IN-PROGRESS",\n  "status": "IN-PROGRESS"\n}',
        },
      ],
    };
  }

  test("native-tool object response is copied onto tool_result", () => {
    const payload = realAgentPayload();
    normalizeToolResult(payload);
    const result = payload["tool_result"] as Record<string, unknown>;
    expect(result["resolvedModel"]).toBe("claude-haiku-4-5-20251001");
    expect(result["agentId"]).toBe("af3976c1820b38d69");
  });

  test("MCP envelope is unwrapped and its stringified JSON parsed onto tool_result", () => {
    const payload = realMcpPayload();
    normalizeToolResult(payload);
    const result = payload["tool_result"] as Record<string, unknown>;
    expect(result["success"]).toBe(true);
    expect(result["status"]).toBe("IN-PROGRESS");
  });

  test("an already-usable tool_result (hand-built test payload) is never overwritten", () => {
    const payload = realMcpPayload();
    payload["tool_result"] = { success: false, marker: "hand-built" };
    normalizeToolResult(payload);
    expect((payload["tool_result"] as Record<string, unknown>)["marker"]).toBe("hand-built");
  });

  test("a non-JSON text block leaves the payload untouched (fail-open)", () => {
    const payload = realMcpPayload();
    payload["tool_response"] = [{ type: "text", text: "plain prose output, not JSON" }];
    normalizeToolResult(payload);
    expect(payload["tool_result"]).toBeUndefined();
  });

  test("an absent tool_response leaves the payload untouched", () => {
    const payload = realMcpPayload();
    delete payload["tool_response"];
    normalizeToolResult(payload);
    expect(payload["tool_result"]).toBeUndefined();
  });

  test("an envelope whose JSON parses to an array is not assigned (tool_result stays object-typed)", () => {
    const payload = realMcpPayload();
    payload["tool_response"] = [{ type: "text", text: "[1, 2, 3]" }];
    normalizeToolResult(payload);
    expect(payload["tool_result"]).toBeUndefined();
  });

  test("a non-PostToolUse payload is never mutated (PR #2402 R1)", () => {
    const payload = realMcpPayload();
    payload["hook_event_name"] = "PreToolUse";
    const before = JSON.stringify(payload);
    normalizeToolResult(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });

  test("a raw JSON-string tool_response is parsed (PR #2402 R1)", () => {
    const payload = realMcpPayload();
    payload["tool_response"] = '{"success": true, "marker": "string-shaped"}';
    normalizeToolResult(payload);
    expect((payload["tool_result"] as Record<string, unknown>)["marker"]).toBe("string-shaped");
  });
});

/**
 * End-to-end acceptance (mt#3308 AT1): a production-shaped payload drives a previously-DEAD
 * hook's decision path to its intended behavior. Pre-fix, both hooks below returned their
 * silent/false branch on every production payload — the envelope key never matched.
 */
describe("normalizeToolResult heals previously-dead hooks end-to-end (mt#3308 AT1)", () => {
  test("drive-pr-to-convergence emits its reminder from a production-shaped pr_create payload", () => {
    const payload: Record<string, unknown> = {
      session_id: "e2e",
      cwd: "/tmp",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__minsky__session_pr_create",
      tool_input: { title: "x", type: "fix" },
      // The captured MCP envelope pattern carrying a REAL session_pr_create result shape
      // (PR #2400's actual return, trimmed).
      tool_response: [
        {
          type: "text",
          text: '{"success": true, "url": "https://github.com/edobry/minsky/pull/2400", "statusTransition": {"from": "IN-PROGRESS", "to": "IN-REVIEW", "succeeded": true}}',
        },
      ],
    };

    // Pre-fix condition: without normalization the reminder never fires.
    expect(decideReminderFromPayload(payload as never)).toBeNull();

    normalizeToolResult(payload);
    const reminder = decideReminderFromPayload(payload as never);
    expect(reminder).not.toBeNull();
    expect(reminder).toContain("Drive it to convergence");
  });

  test("bridge-memory-retirement detects a DONE transition from a production-shaped merge payload", () => {
    const payload: Record<string, unknown> = {
      session_id: "e2e",
      cwd: "/tmp",
      hook_event_name: "PostToolUse",
      tool_name: "mcp__minsky__session_pr_merge",
      tool_input: { task: "mt#0000" },
      tool_response: [{ type: "text", text: '{"success": true}' }],
    };

    expect(isDoneTransition(payload as never)).toBe(false);

    normalizeToolResult(payload);
    expect(isDoneTransition(payload as never)).toBe(true);
  });
});

describe("deriveHookRepoRoot (mt#3393)", () => {
  // Built with `resolve`/`join` rather than POSIX string literals: findRepoRoot
  // normalizes through `resolve()`, so a hardcoded "/Users/..." expectation
  // would not match the normalized value on a platform with different path
  // semantics.
  const MAIN_WORKSPACE = resolve(join("/", "dev-home", "Projects", "minsky"));
  const HOOK_DIR = join(MAIN_WORKSPACE, ".claude", "hooks");
  const SESSIONS_ROOT = resolve(join("/", "dev-home", ".local", "state", "minsky", "sessions"));
  const SESSION_CLONE = join(SESSIONS_ROOT, "aaaa-1111");
  const CLEANED_SESSION = join(SESSIONS_ROOT, "bbbb-2222");

  /**
   * Two directories carry a real `.git` DIRECTORY: the main workspace and a
   * live session clone. `CLEANED_SESSION` deliberately carries none, and has
   * no `.git` anywhere above it either — the state a session workspace is
   * left in after cleanup, which is where 11 of the 22 stray calibration logs
   * landed.
   */
  const GIT_ENTRIES = new Set([MAIN_WORKSPACE, SESSION_CLONE].map((r) => join(r, ".git")));

  const fakeFs: MergeDetectFs = {
    existsSync: (p) => GIT_ENTRIES.has(p),
    readFileSync: () => "",
    statSync: () => ({ isDirectory: () => true, isFile: () => false }),
  };

  test("resolves the hook installation's own repo regardless of the invoking cwd", () => {
    expect(deriveHookRepoRoot(HOOK_DIR, fakeFs)).toBe(MAIN_WORKSPACE);
  });

  test("a session clone as cwd does not move the resolved root", () => {
    // This is the contrast the fix turns on: findRepoRoot(cwd) answers with
    // the session clone, deriveHookRepoRoot answers with the main workspace.
    expect(findRepoRoot(join(SESSION_CLONE, "src"), fakeFs)).toBe(SESSION_CLONE);
    expect(deriveHookRepoRoot(HOOK_DIR, fakeFs)).toBe(MAIN_WORKSPACE);
  });

  test("a cleaned-up session path as cwd does not yield a bogus root", () => {
    // findRepoRoot's missing-repo fallback returns the start directory itself,
    // so the caller would treat an empty leftover directory as a repo root —
    // which is what fed an EMPTY policy corpus to the coverage decision and
    // made every action there record `uncovered`.
    expect(findRepoRoot(CLEANED_SESSION, fakeFs)).toBe(CLEANED_SESSION);
    expect(deriveHookRepoRoot(HOOK_DIR, fakeFs)).toBe(MAIN_WORKSPACE);
  });

  test("the real hook installation resolves to a repo containing .minsky/hooks", () => {
    // Guards the production default (no injected startDir/fs): whichever tree
    // this test runs from, the resolved root must be the checkout that owns
    // the hook sources — not a parent directory or the filesystem root.
    const root = deriveHookRepoRoot();
    // eslint-disable-next-line custom/no-real-fs-in-tests -- reading the real tree IS the assertion: the three tests above inject startDir, so none of them would catch the default changing to process.cwd()
    expect(existsSync(join(root, ".minsky", "hooks", "types.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readPositiveIntEnv (mt#3518 — preference-class threshold config channel)
// ---------------------------------------------------------------------------

describe("readPositiveIntEnv", () => {
  test("returns the default when the var is absent or blank", () => {
    expect(readPositiveIntEnv("X", 200, {})).toBe(200);
    expect(readPositiveIntEnv("X", 200, { X: "" })).toBe(200);
    expect(readPositiveIntEnv("X", 200, { X: "   " })).toBe(200);
  });

  test("returns the parsed value for a positive integer", () => {
    expect(readPositiveIntEnv("X", 200, { X: "350" })).toBe(350);
    expect(readPositiveIntEnv("X", 10, { X: "1" })).toBe(1);
  });

  test("falls back to the default on malformed or non-positive input — never breaks a guard", () => {
    expect(readPositiveIntEnv("X", 200, { X: "abc" })).toBe(200);
    expect(readPositiveIntEnv("X", 200, { X: "0" })).toBe(200);
    expect(readPositiveIntEnv("X", 200, { X: "-5" })).toBe(200);
    expect(readPositiveIntEnv("X", 200, { X: "2.5" })).toBe(200);
    expect(readPositiveIntEnv("X", 200, { X: "NaN" })).toBe(200);
    expect(readPositiveIntEnv("X", 200, { X: "Infinity" })).toBe(200);
  });

  test("rejects an override above the ceiling — a tune must not become a silent off switch", () => {
    // PR #2526 R1. The typo case: an extra zero on the 200-word budget.
    expect(readPositiveIntEnv("X", 200, { X: "2000" })).toBe(2000); // exactly at 10x — allowed
    expect(readPositiveIntEnv("X", 200, { X: "2001" })).toBe(200); // past it — ignored
    expect(readPositiveIntEnv("X", 200, { X: "999999" })).toBe(200);
    // The ceiling scales with the guard's own default, not an absolute number.
    expect(readPositiveIntEnv("X", 10, { X: "100" })).toBe(100);
    expect(readPositiveIntEnv("X", 10, { X: "101" })).toBe(10);
  });
});
