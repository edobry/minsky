// Tests for .minsky/hooks/fire-log.ts — mt#2597 (evaluation-loop Phase 1).
//
// Every test uses an in-memory fs fixture (mirrors guard-health.test.ts's
// pattern) — no test in this file touches the real filesystem or the real
// MINSKY_STATE_DIR, closing the mt#2876 class (a guard-health test polluted
// the real state-dir log by writing through the default-wired path) before
// it can recur for this new module.

import { describe, test, expect } from "bun:test";
import {
  recordFireLogEntry,
  readFireLogEntries,
  summarizeFireLog,
  getFireLogSummary,
  classifyOverride,
  getFireLogStateDir,
  getFireLogPath,
  type FireLogEntry,
  type FireLogFsDeps,
} from "./fire-log";

// ---------------------------------------------------------------------------
// In-memory fs fixture
// ---------------------------------------------------------------------------

function makeInMemoryFs(initial?: Record<string, string>): FireLogFsDeps & {
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    existsSync: (p: string) => p in files || Object.keys(files).some((k) => k.startsWith(p)),
    mkdirSync: () => {
      /* no-op — flat in-memory map */
    },
    appendFileSync: (p: string, data: string) => {
      files[p] = (files[p] ?? "") + data;
    },
    readFileSync: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p] as string;
    },
  };
}

const LOG_PATH = "/fake/state/fire-log.jsonl";

// Shared fixture literals — extracted to satisfy custom/no-magic-string-duplication.
const HOOK_OVERRIDE_VAR_NAME = "MINSKY_HOOK_OVERRIDE";
const SKIP_FRESHNESS_VAR_NAME = "MINSKY_SKIP_FRESHNESS";
const AUTHORIZED_EXCEPTION = "authorized_exception";

describe("getFireLogStateDir / getFireLogPath", () => {
  test("honors MINSKY_STATE_DIR override", () => {
    const dir = getFireLogStateDir({ MINSKY_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv);
    expect(dir).toBe("/custom/state");
    const logPath = getFireLogPath({ MINSKY_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv);
    expect(logPath).toBe("/custom/state/fire-log.jsonl");
  });

  test("falls back to ~/.local/state/minsky when unset", () => {
    const dir = getFireLogStateDir({} as NodeJS.ProcessEnv);
    expect(dir).toContain(".local/state/minsky");
  });
});

// ---------------------------------------------------------------------------
// classifyOverride — the RFC Part 1 three-way split
// ---------------------------------------------------------------------------

describe("classifyOverride", () => {
  const oracle = new Set([HOOK_OVERRIDE_VAR_NAME, SKIP_FRESHNESS_VAR_NAME]);

  test("a known/registered override env-var name -> authorized_exception", () => {
    expect(classifyOverride(HOOK_OVERRIDE_VAR_NAME, oracle)).toBe(AUTHORIZED_EXCEPTION);
    expect(classifyOverride(SKIP_FRESHNESS_VAR_NAME, oracle)).toBe(AUTHORIZED_EXCEPTION);
  });

  test("an env-var name NOT present in the oracle -> unclassified", () => {
    expect(classifyOverride("MINSKY_SOME_UNREGISTERED_VAR", oracle)).toBe("unclassified");
  });

  test("no env-var involved at all (e.g. grant-file channel) -> contested", () => {
    expect(classifyOverride(undefined, oracle)).toBe("contested");
  });

  test("defaults to the real KNOWN_OVERRIDE_ENV_VARS oracle when not supplied", () => {
    // MINSKY_HOOK_OVERRIDE is the dispatcher's own D3 unified override var —
    // must always be present in the real oracle.
    expect(classifyOverride(HOOK_OVERRIDE_VAR_NAME)).toBe(AUTHORIZED_EXCEPTION);
    expect(classifyOverride("MINSKY_TOTALLY_MADE_UP_VAR_NAME")).toBe("unclassified");
  });
});

// ---------------------------------------------------------------------------
// recordFireLogEntry / readFireLogEntries — the JSONL round-trip
// ---------------------------------------------------------------------------

describe("recordFireLogEntry", () => {
  test("appends a well-formed JSONL line with guard name, event, decision, duration, timestamp", () => {
    const fs = makeInMemoryFs();
    recordFireLogEntry(
      { guardName: "test-guard", event: "PreToolUse", decision: "deny", durationMs: 3 },
      { logPath: LOG_PATH, fs, now: () => new Date("2026-07-16T00:00:00.000Z") }
    );

    const entries = readFireLogEntries({ logPath: LOG_PATH, fs });
    expect(entries.length).toBe(1);
    const ev = entries[0] as FireLogEntry;
    expect(ev.guardName).toBe("test-guard");
    expect(ev.event).toBe("PreToolUse");
    expect(ev.decision).toBe("deny");
    expect(ev.durationMs).toBe(3);
    expect(ev.timestamp).toBe("2026-07-16T00:00:00.000Z");
    expect(ev.overrideEnvVar).toBeUndefined();
    expect(ev.overrideClassification).toBeUndefined();
  });

  test("records override env-var + classification when supplied (authorized_exception, per acceptance test)", () => {
    const fs = makeInMemoryFs();
    recordFireLogEntry(
      {
        guardName: "check-branch-fresh",
        event: "PreToolUse",
        decision: "allow",
        durationMs: 1,
        overrideEnvVar: SKIP_FRESHNESS_VAR_NAME,
        overrideClassification: AUTHORIZED_EXCEPTION,
        toolName: "mcp__minsky__session_commit",
        sessionId: "sess-9",
      },
      { logPath: LOG_PATH, fs }
    );
    const entries = readFireLogEntries({ logPath: LOG_PATH, fs });
    expect(entries[0]?.overrideEnvVar).toBe(SKIP_FRESHNESS_VAR_NAME);
    expect(entries[0]?.overrideClassification).toBe(AUTHORIZED_EXCEPTION);
    expect(entries[0]?.toolName).toBe("mcp__minsky__session_commit");
    expect(entries[0]?.sessionId).toBe("sess-9");
  });

  test("NEVER throws even when the fs seam throws on every call (fail-open) -- guarded operation still completes", () => {
    const brokenFs: FireLogFsDeps = {
      existsSync: () => {
        throw new Error("fs is down");
      },
      mkdirSync: () => {
        throw new Error("fs is down");
      },
      appendFileSync: () => {
        throw new Error("fs is down");
      },
      readFileSync: () => {
        throw new Error("fs is down");
      },
    };
    expect(() =>
      recordFireLogEntry(
        { guardName: "g", event: "PreToolUse", decision: "allow", durationMs: 0 },
        { logPath: LOG_PATH, fs: brokenFs }
      )
    ).not.toThrow();
  });

  test("appendFileSync alone throwing (dir exists) still never propagates", () => {
    const throwingAppend: FireLogFsDeps = {
      existsSync: () => true,
      mkdirSync: () => {},
      appendFileSync: () => {
        throw new Error("disk full");
      },
      readFileSync: () => "",
    };
    expect(() =>
      recordFireLogEntry(
        { guardName: "g", event: "PreToolUse", decision: "deny", durationMs: 5 },
        { logPath: LOG_PATH, fs: throwingAppend }
      )
    ).not.toThrow();
  });

  test("a write failure emits a non-throwing 'degraded' stderr marker naming the guard (acceptance test: destination killed -> operation still completes, degraded marker emitted)", () => {
    const throwingAppend: FireLogFsDeps = {
      existsSync: () => true,
      mkdirSync: () => {},
      appendFileSync: () => {
        throw new Error("EACCES: permission denied");
      },
      readFileSync: () => "",
    };
    const stderrWrites: string[] = [];
    recordFireLogEntry(
      {
        guardName: "check-generated-file-edit",
        event: "PreToolUse",
        decision: "deny",
        durationMs: 2,
      },
      { logPath: LOG_PATH, fs: throwingAppend, stderrWrite: (s) => stderrWrites.push(s) }
    );
    expect(stderrWrites.length).toBe(1);
    expect(stderrWrites[0]).toContain("[fire-log] degraded");
    expect(stderrWrites[0]).toContain("check-generated-file-edit");
  });

  test("even the degraded-marker stderr write itself throwing never propagates", () => {
    const throwingAppend: FireLogFsDeps = {
      existsSync: () => true,
      mkdirSync: () => {},
      appendFileSync: () => {
        throw new Error("disk full");
      },
      readFileSync: () => "",
    };
    expect(() =>
      recordFireLogEntry(
        { guardName: "g", event: "PreToolUse", decision: "deny", durationMs: 1 },
        {
          logPath: LOG_PATH,
          fs: throwingAppend,
          stderrWrite: () => {
            throw new Error("stderr is broken too");
          },
        }
      )
    ).not.toThrow();
  });
});

describe("readFireLogEntries", () => {
  test("skips malformed lines and returns only valid entries", () => {
    const fs = makeInMemoryFs({
      [LOG_PATH]:
        `${JSON.stringify({
          timestamp: "2026-07-16T00:00:00.000Z",
          guardName: "g",
          event: "PreToolUse",
          decision: "allow",
          durationMs: 1,
        })}\n` +
        "not json\n" +
        `${JSON.stringify({ missing: "fields" })}\n` +
        `${JSON.stringify({
          timestamp: "2026-07-16T00:00:01.000Z",
          guardName: "g",
          event: "PreToolUse",
          decision: "bogus-decision",
          durationMs: 1,
        })}\n`,
    });
    const entries = readFireLogEntries({ logPath: LOG_PATH, fs });
    expect(entries.length).toBe(1);
    expect(entries[0]?.guardName).toBe("g");
  });

  test("missing log file returns empty array, does not throw", () => {
    const fs = makeInMemoryFs();
    expect(readFireLogEntries({ logPath: LOG_PATH, fs })).toEqual([]);
  });

  test("a fs seam that throws on read degrades to empty array, never throws", () => {
    const brokenFs: FireLogFsDeps = {
      existsSync: () => true,
      mkdirSync: () => {},
      appendFileSync: () => {},
      readFileSync: () => {
        throw new Error("disk error");
      },
    };
    expect(() => readFireLogEntries({ logPath: LOG_PATH, fs: brokenFs })).not.toThrow();
    expect(readFireLogEntries({ logPath: LOG_PATH, fs: brokenFs })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// summarizeFireLog / getFireLogSummary — pure aggregation
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<FireLogEntry> & { timestamp: string }): FireLogEntry {
  return {
    guardName: "test-guard",
    event: "PreToolUse",
    decision: "allow",
    durationMs: 1,
    ...overrides,
  };
}

describe("summarizeFireLog", () => {
  test("no entries -> zero-filled summary", () => {
    const summary = summarizeFireLog([]);
    expect(summary.totalFires).toBe(0);
    expect(Object.keys(summary.byGuard).length).toBe(0);
  });

  test("counts fires per guard, per decision", () => {
    const summary = summarizeFireLog([
      makeEntry({ timestamp: "2026-07-16T00:00:00.000Z", decision: "allow" }),
      makeEntry({ timestamp: "2026-07-16T00:00:01.000Z", decision: "deny" }),
      makeEntry({ timestamp: "2026-07-16T00:00:02.000Z", decision: "allow" }),
      makeEntry({
        timestamp: "2026-07-16T00:00:03.000Z",
        guardName: "other-guard",
        decision: "warn",
      }),
    ]);
    expect(summary.totalFires).toBe(4);
    expect(summary.byGuard["test-guard"]?.fireCount).toBe(3);
    expect(summary.byGuard["test-guard"]?.byDecision).toEqual({ allow: 2, warn: 0, deny: 1 });
    expect(summary.byGuard["other-guard"]?.fireCount).toBe(1);
    expect(summary.byGuard["other-guard"]?.byDecision).toEqual({ allow: 0, warn: 1, deny: 0 });
  });

  test("satisfies the Phase-1 GATE shape: a guard with >=5 fires is distinguishable from one with fewer", () => {
    const fiveFires = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ timestamp: `2026-07-16T00:00:0${i}.000Z`, guardName: "busy-guard" })
    );
    const summary = summarizeFireLog([
      ...fiveFires,
      makeEntry({ timestamp: "2026-07-16T00:00:00.000Z", guardName: "quiet-guard" }),
    ]);
    expect(summary.byGuard["busy-guard"]?.fireCount).toBeGreaterThanOrEqual(5);
    expect(summary.byGuard["quiet-guard"]?.fireCount).toBeLessThan(5);
  });

  test("tracks override counts by classification", () => {
    const summary = summarizeFireLog([
      makeEntry({
        timestamp: "2026-07-16T00:00:00.000Z",
        overrideEnvVar: SKIP_FRESHNESS_VAR_NAME,
        overrideClassification: AUTHORIZED_EXCEPTION,
      }),
      makeEntry({
        timestamp: "2026-07-16T00:00:01.000Z",
        overrideEnvVar: "MINSKY_MADE_UP",
        overrideClassification: "unclassified",
      }),
      makeEntry({ timestamp: "2026-07-16T00:00:02.000Z", overrideClassification: "contested" }),
      makeEntry({ timestamp: "2026-07-16T00:00:03.000Z" }), // no override at all
    ]);
    const g = summary.byGuard["test-guard"];
    expect(g?.overrideCount).toBe(3);
    expect(g?.overridesByClassification).toEqual({
      [AUTHORIZED_EXCEPTION]: 1,
      unclassified: 1,
      contested: 1,
    });
  });

  test("tracks the last fire timestamp per guard", () => {
    const summary = summarizeFireLog([
      makeEntry({ timestamp: "2026-07-16T00:00:00.000Z" }),
      makeEntry({ timestamp: "2026-07-16T00:05:00.000Z" }),
      makeEntry({ timestamp: "2026-07-16T00:02:00.000Z" }),
    ]);
    expect(summary.byGuard["test-guard"]?.lastFireTimestamp).toBe("2026-07-16T00:05:00.000Z");
  });
});

describe("getFireLogSummary", () => {
  test("reads the log fresh from disk (via injected fs) and computes the summary", () => {
    const fs = makeInMemoryFs();
    recordFireLogEntry(
      { guardName: "g", event: "PreToolUse", decision: "deny", durationMs: 2 },
      { logPath: LOG_PATH, fs }
    );
    const summary = getFireLogSummary({ logPath: LOG_PATH, fs });
    expect(summary.totalFires).toBe(1);
    expect(summary.byGuard["g"]?.byDecision.deny).toBe(1);
  });

  test("degrades to a zero-filled summary rather than throwing on a broken fs seam", () => {
    const brokenFs: FireLogFsDeps = {
      existsSync: () => {
        throw new Error("fs is down");
      },
      mkdirSync: () => {},
      appendFileSync: () => {},
      readFileSync: () => {
        throw new Error("fs is down");
      },
    };
    expect(() => getFireLogSummary({ logPath: LOG_PATH, fs: brokenFs })).not.toThrow();
    expect(getFireLogSummary({ logPath: LOG_PATH, fs: brokenFs })).toEqual({
      byGuard: {},
      totalFires: 0,
    });
  });
});
