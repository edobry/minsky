/**
 * Unit tests for the session-detail pure helpers (mt#1919).
 */
import { describe, test, expect } from "bun:test";
import {
  githubRepoWebBase,
  parseGitLog,
  buildSessionMeta,
  buildPrRef,
  GIT_LOG_FORMAT,
} from "./session-detail";
import type { SessionRecord } from "@minsky/domain/session/types";

describe("githubRepoWebBase", () => {
  test("https remote with .git suffix", () => {
    expect(githubRepoWebBase("https://github.com/edobry/minsky.git")).toBe(
      "https://github.com/edobry/minsky"
    );
  });

  test("https remote without .git suffix", () => {
    expect(githubRepoWebBase("https://github.com/edobry/minsky")).toBe(
      "https://github.com/edobry/minsky"
    );
  });

  test("ssh remote", () => {
    expect(githubRepoWebBase("git@github.com:edobry/minsky.git")).toBe(
      "https://github.com/edobry/minsky"
    );
  });

  test("non-GitHub remote returns null", () => {
    expect(githubRepoWebBase("https://gitlab.com/o/r.git")).toBeNull();
  });

  test("null/undefined/empty return null", () => {
    expect(githubRepoWebBase(null)).toBeNull();
    expect(githubRepoWebBase(undefined)).toBeNull();
    expect(githubRepoWebBase("")).toBeNull();
  });
});

describe("parseGitLog", () => {
  const base = "https://github.com/edobry/minsky";

  test("parses well-formed lines into refs with URLs", () => {
    const stdout = [
      `abc1234def5678abc1234def5678abc1234def56\t2026-06-10T12:00:00-04:00\tfeat(mt#1919): add page`,
      `1234567\t2026-06-09T10:00:00-04:00\tfix: something`,
    ].join("\n");
    const refs = parseGitLog(stdout, base);
    expect(refs).toHaveLength(2);
    expect(refs[0]?.shortHash).toBe("abc1234");
    expect(refs[0]?.url).toBe(`${base}/commit/abc1234def5678abc1234def5678abc1234def56`);
    expect(refs[0]?.subject).toBe("feat(mt#1919): add page");
    expect(refs[1]?.date).toBe("2026-06-09T10:00:00-04:00");
  });

  test("subject containing tabs is preserved", () => {
    const refs = parseGitLog(`1234567\t2026-06-10T12:00:00Z\ta\tb\tc`, null);
    expect(refs[0]?.subject).toBe("a\tb\tc");
  });

  test("null repo base yields null urls", () => {
    const refs = parseGitLog(`1234567\t2026-06-10T12:00:00Z\tx`, null);
    expect(refs[0]?.url).toBeNull();
  });

  test("malformed lines and blank lines are skipped", () => {
    const stdout = ["not-a-hash\tdate\tsubject", "", "1234567\tbad-date\tok"].join("\n");
    const refs = parseGitLog(stdout, null);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.date).toBeNull();
    expect(refs[0]?.subject).toBe("ok");
  });

  test("empty output yields empty list", () => {
    expect(parseGitLog("", null)).toEqual([]);
  });

  test("format constant covers hash, date, subject", () => {
    expect(GIT_LOG_FORMAT).toContain("%H");
    expect(GIT_LOG_FORMAT).toContain("%cI");
    expect(GIT_LOG_FORMAT).toContain("%s");
  });
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "561a8568-cb5e-44d0-bcee-bf8c8da2f011",
    repoName: "edobry-minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: "2026-06-10T20:00:00Z",
    ...overrides,
  };
}

const TASK_TITLE = "Session detail page";

describe("buildSessionMeta", () => {
  test("maps record fields and formats the task id", () => {
    const meta = buildSessionMeta(
      record({
        taskId: "mt#1919",
        branch: "task/mt-1919",
        lastActivityAt: new Date().toISOString(),
        lastCommitHash: "abc1234",
        commitCount: 3,
        agentId: "agent:local:foo",
      }),
      TASK_TITLE
    );
    expect(meta.sessionId).toBe("561a8568-cb5e-44d0-bcee-bf8c8da2f011");
    expect(meta.taskId).toBe("mt#1919");
    expect(meta.taskTitle).toBe(TASK_TITLE);
    expect(meta.branch).toBe("task/mt-1919");
    expect(meta.commitCount).toBe(3);
    expect(meta.agentId).toBe("agent:local:foo");
    expect(["healthy", "idle", "stale", "orphaned"]).toContain(meta.liveness);
  });

  test("missing optionals map to nulls", () => {
    const meta = buildSessionMeta(record(), null);
    expect(meta.taskId).toBeNull();
    expect(meta.taskTitle).toBeNull();
    expect(meta.branch).toBeNull();
    expect(meta.agentId).toBeNull();
    expect(meta.lastCommitHash).toBeNull();
    expect(meta.commitCount).toBeNull();
  });
});

describe("buildPrRef", () => {
  test("rich pullRequest info takes precedence", () => {
    const ref = buildPrRef(
      record({
        pullRequest: {
          number: 1700,
          url: "https://github.com/edobry/minsky/pull/1700",
          state: "open",
          createdAt: "2026-06-10T21:00:00Z",
          headBranch: "task/mt-1919",
          baseBranch: "main",
          lastSynced: "2026-06-10T21:05:00Z",
          title: TASK_TITLE,
        },
        prApproved: true,
        prState: {
          branchName: "task/mt-1919",
          exists: true,
          lastChecked: "2026-06-10T21:00:00Z",
        },
      })
    );
    expect(ref).not.toBeNull();
    expect(ref?.number).toBe(1700);
    expect(ref?.state).toBe("open");
    expect(ref?.title).toBe(TASK_TITLE);
    expect(ref?.approved).toBe(true);
  });

  test("falls back to prState branch record", () => {
    const ref = buildPrRef(
      record({
        prState: {
          branchName: "task/mt-1919",
          exists: true,
          lastChecked: "2026-06-10T21:00:00Z",
        },
      })
    );
    expect(ref?.number).toBeNull();
    expect(ref?.headBranch).toBe("task/mt-1919");
    expect(ref?.state).toBe("unknown");
  });

  test("merged prState reports merged", () => {
    const ref = buildPrRef(
      record({
        prState: {
          branchName: "task/mt-1919",
          exists: true,
          lastChecked: "2026-06-10T21:00:00Z",
          mergedAt: "2026-06-10T22:00:00Z",
        },
      })
    );
    expect(ref?.state).toBe("merged");
  });

  test("no PR data returns null", () => {
    expect(buildPrRef(record())).toBeNull();
  });
});
