/**
 * Tests for `ClaudeStreamJsonTransport`'s `auth_mode` env resolution
 * (mt#4935, ADR-047 §Consequences).
 *
 * CRITICAL TESTING CONSTRAINT (inherited from ./driven-session-host.test.ts's
 * docblock): every test injects a fake `spawnFn` — NO test spawns the real
 * `claude` binary. `getAnthropicApiKey` is likewise always injected here
 * (never the real `readConfiguredAnthropicApiKey`, which reaches the global
 * configuration singleton) — no `spyOn`, per `testing-standards.mdc §Testable
 * Design`.
 *
 * @see ./claude-transport.ts
 * @see mt#4935
 */
/* eslint-disable custom/no-real-fs-in-tests -- mt#3397: spawn/spawnResume preflight the cwd against the REAL filesystem, so the test cwd has to be a real directory — there is no fs to inject through the code path under test. */
import { describe, test, expect, afterAll } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ClaudeStreamJsonTransport } from "./claude-transport";
import type { ProcessLike, SpawnFn, SpawnOptions } from "./driver-transport";

class FakeClaudeProcess extends EventEmitter implements ProcessLike {
  readonly pid: number | undefined = 424242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  kill(): boolean {
    return true;
  }
}

interface SpawnCapture {
  command: string;
  args: string[];
  options: SpawnOptions;
  proc: FakeClaudeProcess;
}

function makeFakeSpawnFn(): { spawnFn: SpawnFn; calls: SpawnCapture[] } {
  const calls: SpawnCapture[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    const proc = new FakeClaudeProcess();
    calls.push({ command, args, options, proc });
    return proc;
  };
  return { spawnFn, calls };
}

function first<T>(arr: T[]): T {
  const item = arr[0];
  if (item === undefined) throw new Error("expected at least one element in array");
  return item;
}

const TEST_CWD = mkdtempSync(join(tmpdir(), "claude-transport-"));
const BYPASS_PERMISSIONS = "bypassPermissions";
const UNUSED_API_KEY = "sk-ant-should-never-be-read";

afterAll(() => {
  rmSync(TEST_CWD, { recursive: true, force: true });
});

describe("ClaudeStreamJsonTransport.spawn — auth_mode env resolution (mt#4935)", () => {
  test('"subscription" (default) leaves env exactly as given — no ANTHROPIC_API_KEY added', () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const transport = new ClaudeStreamJsonTransport({
      spawnFn,
      getAnthropicApiKey: () => UNUSED_API_KEY,
    });

    const result = transport.spawn({
      cwd: TEST_CWD,
      permissionMode: BYPASS_PERMISSIONS,
      authMode: "subscription",
      mcpConfig: null,
      env: { PATH: "/usr/bin" },
    });

    expect(result.ok).toBe(true);
    const call = first(calls);
    expect(call.options.env).toEqual({ PATH: "/usr/bin" });
  });

  test('omitted authMode behaves the same as "subscription" — no env mutation', () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const transport = new ClaudeStreamJsonTransport({
      spawnFn,
      getAnthropicApiKey: () => UNUSED_API_KEY,
    });

    transport.spawn({
      cwd: TEST_CWD,
      permissionMode: BYPASS_PERMISSIONS,
      mcpConfig: null,
      env: { PATH: "/usr/bin" },
    });

    expect(first(calls).options.env).toEqual({ PATH: "/usr/bin" });
  });

  test('"api-key" with a configured credential sets ANTHROPIC_API_KEY, preserving the rest of env', () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const transport = new ClaudeStreamJsonTransport({
      spawnFn,
      getAnthropicApiKey: () => "sk-ant-configured-key",
    });

    transport.spawn({
      cwd: TEST_CWD,
      permissionMode: BYPASS_PERMISSIONS,
      authMode: "api-key",
      mcpConfig: null,
      env: { PATH: "/usr/bin", HOME: "/home/operator" },
    });

    const env = first(calls).options.env;
    expect(env?.ANTHROPIC_API_KEY).toBe("sk-ant-configured-key");
    expect(env?.PATH).toBe("/usr/bin");
    expect(env?.HOME).toBe("/home/operator");
  });

  test('"api-key" never leaks the credential into argv', () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const transport = new ClaudeStreamJsonTransport({
      spawnFn,
      getAnthropicApiKey: () => "sk-ant-must-not-appear-in-argv",
    });

    transport.spawn({
      cwd: TEST_CWD,
      permissionMode: BYPASS_PERMISSIONS,
      authMode: "api-key",
      mcpConfig: null,
    });

    expect(first(calls).args.join(" ")).not.toContain("sk-ant-must-not-appear-in-argv");
  });

  test('"api-key" with NO configured credential degrades to unmodified env (never throws)', () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const transport = new ClaudeStreamJsonTransport({
      spawnFn,
      getAnthropicApiKey: () => null,
    });

    const result = transport.spawn({
      cwd: TEST_CWD,
      permissionMode: BYPASS_PERMISSIONS,
      authMode: "api-key",
      mcpConfig: null,
      env: { PATH: "/usr/bin" },
    });

    expect(result.ok).toBe(true);
    expect(first(calls).options.env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("ClaudeStreamJsonTransport.spawnResume — auth_mode env resolution (mt#4935)", () => {
  test('"api-key" with a configured credential sets ANTHROPIC_API_KEY on resume too', () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const transport = new ClaudeStreamJsonTransport({
      spawnFn,
      getAnthropicApiKey: () => "sk-ant-resume-key",
    });

    transport.spawnResume({
      cwd: TEST_CWD,
      permissionMode: BYPASS_PERMISSIONS,
      authMode: "api-key",
      harnessSessionId: "harness-1",
      mcpConfig: null,
      env: { PATH: "/usr/bin" },
    });

    const env = first(calls).options.env;
    expect(env?.ANTHROPIC_API_KEY).toBe("sk-ant-resume-key");
    expect(env?.PATH).toBe("/usr/bin");
  });

  test('"subscription" on resume leaves env untouched', () => {
    const { spawnFn, calls } = makeFakeSpawnFn();
    const transport = new ClaudeStreamJsonTransport({
      spawnFn,
      getAnthropicApiKey: () => UNUSED_API_KEY,
    });

    transport.spawnResume({
      cwd: TEST_CWD,
      permissionMode: BYPASS_PERMISSIONS,
      authMode: "subscription",
      harnessSessionId: "harness-1",
      mcpConfig: null,
      env: { PATH: "/usr/bin" },
    });

    expect(first(calls).options.env).toEqual({ PATH: "/usr/bin" });
  });
});
