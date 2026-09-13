/**
 * mt#5132 AT2 (hook half): fed a SessionEnd payload, the hook spawns exactly
 * one `minsky tasks release-conversation <session_id> --reason <reason>` call
 * through the injected spawner, logs the outcome, and never throws — a failed
 * or timed-out spawn is an outcome, not an exit code.
 *
 * Execution evidence: see PR body.
 */

import { describe, it, expect } from "bun:test";
import {
  isOverridden,
  releaseCommandFor,
  runReleaseClaimsOnSessionEnd,
  NO_SESSION_ID_REASON,
  RELEASE_CLAIMS_TIMEOUT_MS,
  type CommandResult,
  type ReleaseClaimsDeps,
  type SessionEndHookInput,
} from "./release-work-package-claims-on-session-end";

const FIXED_NOW = new Date("2026-09-13T12:00:00.000Z");
const SESSION = "dd48af28-f535-41a1-b955-c9a95860810c";
const SUBCOMMAND = "release-conversation";

interface Harness {
  deps: ReleaseClaimsDeps;
  commands: Array<{ cmd: string[]; timeoutMs: number }>;
  logLines: string[];
}

function makeHarness(opts: { result?: CommandResult; throwOnSpawn?: boolean } = {}): Harness {
  const commands: Harness["commands"] = [];
  const logLines: string[] = [];
  const deps: ReleaseClaimsDeps = {
    runCommand: (cmd, o) => {
      commands.push({ cmd, timeoutMs: o.timeoutMs });
      if (opts.throwOnSpawn) throw new Error("spawn failed");
      return opts.result ?? { exitCode: 0, stdout: '{"released":["mt#1"]}', stderr: "" };
    },
    appendLog: (_p, line) => {
      logLines.push(line);
    },
    resolveLogPath: () => "/tmp/test-release-claims-hook-log.jsonl",
    now: () => FIXED_NOW,
    minskyBin: "minsky",
  };
  return { deps, commands, logLines };
}

const input = (over: Partial<SessionEndHookInput> = {}): SessionEndHookInput =>
  ({
    session_id: SESSION,
    cwd: "/repo",
    hook_event_name: "SessionEnd",
    reason: "other",
    ...over,
  }) as SessionEndHookInput;

describe("releaseCommandFor — the argv is the payload, nothing else", () => {
  it("passes session_id and --reason through verbatim", () => {
    expect(releaseCommandFor("minsky", { session_id: SESSION, reason: "logout" })).toEqual([
      "minsky",
      "tasks",
      SUBCOMMAND,
      SESSION,
      "--reason",
      "logout",
    ]);
  });

  it("omits --reason when the payload carries none; the command then treats it as unspecified", () => {
    expect(releaseCommandFor("minsky", { session_id: SESSION })).toEqual([
      "minsky",
      "tasks",
      SUBCOMMAND,
      SESSION,
    ]);
  });

  it("forwards clear and resume unchanged — the COMMAND decides they keep the claim, not the hook", () => {
    expect(releaseCommandFor("minsky", { session_id: SESSION, reason: "clear" })).toContain(
      "clear"
    );
  });
});

describe("runReleaseClaimsOnSessionEnd", () => {
  it("AT2: spawns exactly one bounded release-conversation call and records the outcome", () => {
    const h = makeHarness();
    const out = runReleaseClaimsOnSessionEnd(input(), h.deps);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.cmd).toEqual([
      "minsky",
      "tasks",
      SUBCOMMAND,
      SESSION,
      "--reason",
      "other",
    ]);
    expect(h.commands[0]?.timeoutMs).toBe(RELEASE_CLAIMS_TIMEOUT_MS);
    expect(out).toEqual({
      skipped: false,
      command: h.commands[0]?.cmd,
      exitCode: 0,
      timedOut: false,
    });
    const record = JSON.parse(h.logLines[0] ?? "{}") as Record<string, unknown>;
    expect(record.sessionId).toBe(SESSION);
    expect(record.reason).toBe("other");
    expect(record.release).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it("no session_id → skipped, logged, nothing spawned", () => {
    const h = makeHarness();
    const out = runReleaseClaimsOnSessionEnd(input({ session_id: undefined }), h.deps);
    expect(out).toEqual({ skipped: true, reason: NO_SESSION_ID_REASON });
    expect(h.commands).toHaveLength(0);
    expect(h.logLines[0]).toContain(NO_SESSION_ID_REASON);
  });

  it("a failing command is an outcome with its stderr in the log, not a throw", () => {
    const h = makeHarness({ result: { exitCode: 1, stdout: "", stderr: "connect ETIMEDOUT" } });
    const out = runReleaseClaimsOnSessionEnd(input(), h.deps);
    expect(out.exitCode).toBe(1);
    expect(h.logLines[0]).toContain("connect ETIMEDOUT");
  });

  it("a timed-out command is recorded as timedOut", () => {
    const h = makeHarness({ result: { exitCode: 1, stdout: "", stderr: "", timedOut: true } });
    const out = runReleaseClaimsOnSessionEnd(input(), h.deps);
    expect(out.timedOut).toBe(true);
    expect(JSON.parse(h.logLines[0] ?? "{}")).toMatchObject({ release: { timedOut: true } });
  });

  it("a spawner that throws is caught and logged; the hook still returns", () => {
    const h = makeHarness({ throwOnSpawn: true });
    const out = runReleaseClaimsOnSessionEnd(input(), h.deps);
    expect(out).toMatchObject({ skipped: false, reason: "release-threw" });
    expect(h.logLines[0]).toContain("spawn failed");
  });

  it("a log writer that throws does not break the hook", () => {
    const h = makeHarness();
    h.deps.appendLog = () => {
      throw new Error("disk full");
    };
    expect(() => runReleaseClaimsOnSessionEnd(input(), h.deps)).not.toThrow();
    expect(h.commands).toHaveLength(1);
  });
});

describe("isOverridden — MINSKY_HOOK_OVERRIDE names this hook or all", () => {
  it("matches its own name, case-insensitively, in a comma list, and `all`", () => {
    expect(
      isOverridden({ MINSKY_HOOK_OVERRIDE: "release-work-package-claims-on-session-end" })
    ).toBe(true);
    expect(
      isOverridden({ MINSKY_HOOK_OVERRIDE: "other, Release-Work-Package-Claims-On-Session-End" })
    ).toBe(true);
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: "all" })).toBe(true);
  });

  it("does not match an unset value or another guard's name", () => {
    expect(isOverridden({})).toBe(false);
    expect(isOverridden({ MINSKY_HOOK_OVERRIDE: "transcript-ingest-on-session-end" })).toBe(false);
  });
});
