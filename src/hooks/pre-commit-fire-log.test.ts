// Tests for src/hooks/pre-commit-fire-log.ts — mt#2597 (evaluation-loop
// Phase 1). Mirrors .minsky/hooks/fire-log.test.ts's in-memory fs pattern —
// no test touches the real filesystem or MINSKY_STATE_DIR.

import { describe, test, expect } from "bun:test";
import {
  recordPreCommitFireLogEntry,
  classifyOverride,
  getPreCommitFireLogStateDir,
  getPreCommitFireLogPath,
  type PreCommitFireLogFsDeps,
} from "./pre-commit-fire-log";

function makeInMemoryFs(): PreCommitFireLogFsDeps & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    existsSync: (p: string) => p in files || Object.keys(files).some((k) => k.startsWith(p)),
    mkdirSync: () => {
      /* no-op — flat in-memory map */
    },
    appendFileSync: (p: string, data: string) => {
      files[p] = (files[p] ?? "") + data;
    },
  };
}

const LOG_PATH = "/fake/state/fire-log.jsonl";
// Shared fixture literals — extracted to satisfy custom/no-magic-string-duplication.
const SKIP_NUL_CHECK_VAR_NAME = "MINSKY_SKIP_NUL_CHECK";
const AUTHORIZED_EXCEPTION = "authorized_exception";

describe("getPreCommitFireLogStateDir / getPreCommitFireLogPath", () => {
  test("honors MINSKY_STATE_DIR override", () => {
    expect(
      getPreCommitFireLogStateDir({ MINSKY_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv)
    ).toBe("/custom/state");
    expect(
      getPreCommitFireLogPath({ MINSKY_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv)
    ).toBe("/custom/state/fire-log.jsonl");
  });

  test("falls back to ~/.local/state/minsky when unset", () => {
    expect(getPreCommitFireLogStateDir({} as NodeJS.ProcessEnv)).toContain(".local/state/minsky");
  });
});

describe("classifyOverride (pre-commit side, real HOOK_ONLY_ENV_VARS oracle)", () => {
  test("a real registered pre-commit override env-var -> authorized_exception", () => {
    // MINSKY_SKIP_NUL_CHECK is HOOK_ONLY_ENV_VARS-registered for
    // src/hooks/pre-commit.ts's NUL-byte check (mt#1824).
    expect(classifyOverride(SKIP_NUL_CHECK_VAR_NAME)).toBe(AUTHORIZED_EXCEPTION);
  });

  test("an unregistered env-var name -> unclassified", () => {
    expect(classifyOverride("MINSKY_TOTALLY_MADE_UP_VAR_NAME")).toBe("unclassified");
  });

  test("no env-var involved at all -> contested", () => {
    expect(classifyOverride(undefined)).toBe("contested");
  });
});

describe("recordPreCommitFireLogEntry", () => {
  test("appends a well-formed JSONL line", () => {
    const fs = makeInMemoryFs();
    recordPreCommitFireLogEntry(
      { guardName: "nul-byte-check", decision: "deny", durationMs: 4 },
      { logPath: LOG_PATH, fs, now: () => new Date("2026-07-16T00:00:00.000Z") }
    );
    const content = fs.files[LOG_PATH] ?? "";
    const parsed = JSON.parse(content.trim());
    expect(parsed).toEqual({
      timestamp: "2026-07-16T00:00:00.000Z",
      guardName: "nul-byte-check",
      event: "PreCommit",
      decision: "deny",
      durationMs: 4,
    });
  });

  test("records override env-var + classification when supplied", () => {
    const fs = makeInMemoryFs();
    recordPreCommitFireLogEntry(
      {
        guardName: "nul-byte-check",
        decision: "allow",
        durationMs: 1,
        overrideEnvVar: SKIP_NUL_CHECK_VAR_NAME,
        overrideClassification: AUTHORIZED_EXCEPTION,
      },
      { logPath: LOG_PATH, fs }
    );
    const parsed = JSON.parse((fs.files[LOG_PATH] ?? "").trim());
    expect(parsed.overrideEnvVar).toBe(SKIP_NUL_CHECK_VAR_NAME);
    expect(parsed.overrideClassification).toBe(AUTHORIZED_EXCEPTION);
  });

  test("NEVER throws even when the fs seam throws on every call (fail-open)", () => {
    const brokenFs: PreCommitFireLogFsDeps = {
      existsSync: () => {
        throw new Error("fs is down");
      },
      mkdirSync: () => {
        throw new Error("fs is down");
      },
      appendFileSync: () => {
        throw new Error("fs is down");
      },
    };
    expect(() =>
      recordPreCommitFireLogEntry(
        { guardName: "g", decision: "allow", durationMs: 0 },
        { logPath: LOG_PATH, fs: brokenFs }
      )
    ).not.toThrow();
  });

  test("a write failure emits a non-throwing 'degraded' stderr marker naming the guard", () => {
    const throwingAppend: PreCommitFireLogFsDeps = {
      existsSync: () => true,
      mkdirSync: () => {},
      appendFileSync: () => {
        throw new Error("EACCES: permission denied");
      },
    };
    const stderrWrites: string[] = [];
    recordPreCommitFireLogEntry(
      { guardName: "deploy-domain-check", decision: "deny", durationMs: 2 },
      { logPath: LOG_PATH, fs: throwingAppend, stderrWrite: (s) => stderrWrites.push(s) }
    );
    expect(stderrWrites.length).toBe(1);
    expect(stderrWrites[0]).toContain("[pre-commit-fire-log] degraded");
    expect(stderrWrites[0]).toContain("deploy-domain-check");
  });
});
