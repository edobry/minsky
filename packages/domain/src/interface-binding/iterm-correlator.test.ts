/**
 * Tests for the iTerm-tab correlator (mt#1628).
 */
import { describe, test, expect, mock } from "bun:test";
import type { PresenceClaim, PresenceClaimRepository } from "../presence/index";
import type { CommandExecResult, CommandExecutor } from "../session/focus/types";
import {
  listLiveItermSessionIds,
  classifyAttachment,
  runItermCorrelationPass,
  type CorrelatorSessionProvider,
} from "./iterm-correlator";

function makeClaim(overrides: Partial<PresenceClaim> = {}): PresenceClaim {
  return {
    id: "claim-1",
    subjectKind: "session",
    subjectId: "session-a",
    actorId: "actor-1",
    claimedAt: "2026-07-15T00:00:00.000Z",
    lastRefreshedAt: "2026-07-15T00:05:00.000Z",
    ...overrides,
  };
}

function makeFakeRepo(overrides: Partial<PresenceClaimRepository> = {}): PresenceClaimRepository {
  return {
    upsertClaim: mock(async () => makeClaim()),
    listClaims: mock(async () => []),
    reapStale: mock(async () => 0),
    listAllForKind: mock(async () => []),
    deleteBySubject: mock(async () => 0),
    deleteByIds: mock(async () => 0),
    ...overrides,
  };
}

function makeExecutor(result: CommandExecResult): CommandExecutor {
  return mock(async () => result) as CommandExecutor;
}

describe("classifyAttachment", () => {
  const now = "2026-07-16T12:00:00.000Z";
  const liveIds = new Set(["w0t0p0:LIVE-ID"]);

  test("iterm-tab when TERM_PROGRAM is iTerm.app and the TERM_SESSION_ID is currently live", () => {
    const result = classifyAttachment(
      { terminalContext: { TERM_PROGRAM: "iTerm.app", TERM_SESSION_ID: "w0t0p0:LIVE-ID" } },
      liveIds,
      now
    );
    expect(result).toEqual({ kind: "iterm-tab", surfaceId: "w0t0p0:LIVE-ID", lastObservedAt: now });
  });

  test("unbound when the candidate TERM_SESSION_ID is not among the live ids (tab closed)", () => {
    const result = classifyAttachment(
      { terminalContext: { TERM_PROGRAM: "iTerm.app", TERM_SESSION_ID: "w0t0p0:CLOSED-ID" } },
      liveIds,
      now
    );
    expect(result).toEqual({ kind: "unbound", lastObservedAt: now });
  });

  test("unbound when TERM_PROGRAM is not iTerm.app", () => {
    const result = classifyAttachment(
      { terminalContext: { TERM_PROGRAM: "Apple_Terminal", TERM_SESSION_ID: "w0t0p0:LIVE-ID" } },
      liveIds,
      now
    );
    expect(result).toEqual({ kind: "unbound", lastObservedAt: now });
  });

  test("unbound when there is no terminalContext at all", () => {
    const result = classifyAttachment({ terminalContext: undefined }, liveIds, now);
    expect(result).toEqual({ kind: "unbound", lastObservedAt: now });
  });
});

describe("listLiveItermSessionIds", () => {
  test("parses newline-separated ids from a successful osascript run", async () => {
    const executor = makeExecutor({
      exitCode: 0,
      stdout: "w0t0p0:AAA\nw0t1p0:BBB\n",
      stderr: "",
    });
    const result = await listLiveItermSessionIds(executor);
    expect(result.error).toBeUndefined();
    expect(result.ids).toEqual(new Set(["w0t0p0:AAA", "w0t1p0:BBB"]));
    expect(executor).toHaveBeenCalledWith(expect.arrayContaining(["osascript", "-e"]));
  });

  test("returns an empty set with no error when iTerm2 has no open sessions", async () => {
    const executor = makeExecutor({ exitCode: 0, stdout: "", stderr: "" });
    const result = await listLiveItermSessionIds(executor);
    expect(result.error).toBeUndefined();
    expect(result.ids.size).toBe(0);
  });

  test("reports a permission-denied error distinctly, without throwing", async () => {
    const executor = makeExecutor({
      exitCode: 1,
      stdout: "",
      stderr: "execution error: Not authorized to send Apple events (-1743)",
    });
    const result = await listLiveItermSessionIds(executor);
    expect(result.ids.size).toBe(0);
    expect(result.error).toContain("Automation");
  });

  test("reports a spawn failure (osascript missing) distinctly", async () => {
    const executor = makeExecutor({
      exitCode: 1,
      stdout: "",
      stderr: "no such file or directory",
      spawnError: true,
    });
    const result = await listLiveItermSessionIds(executor);
    expect(result.error).toContain("could not be started");
  });
});

describe("runItermCorrelationPass", () => {
  test("skips entirely (no osascript, no DB read) when the deployment gate fails", async () => {
    const executor = makeExecutor({ exitCode: 0, stdout: "", stderr: "" });
    const repo = makeFakeRepo();
    const updateSession = mock(async () => {});
    const sessionProvider: CorrelatorSessionProvider = { updateSession };

    const result = await runItermCorrelationPass({
      sessionProvider,
      presenceRepo: repo,
      executor,
      platformOverride: "linux",
    });

    expect(result.ran).toBe(false);
    expect(result.skippedReason).toBeTruthy();
    expect(executor).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  test("writes no bindings (but reports ran:true) when osascript enumeration fails", async () => {
    const claim = makeClaim({
      subjectId: "session-a",
      pid: process.pid,
      terminalContext: { TERM_PROGRAM: "iTerm.app", TERM_SESSION_ID: "w0t0p0:AAA" },
    });
    const repo = makeFakeRepo({ listAllForKind: mock(async () => [claim]) });
    const executor = makeExecutor({
      exitCode: 1,
      stdout: "",
      stderr: "execution error: Not authorized to send Apple events (-1743)",
    });
    const updateSession = mock(async () => {});

    const result = await runItermCorrelationPass({
      sessionProvider: { updateSession },
      presenceRepo: repo,
      executor,
      platformOverride: "darwin",
    });

    expect(result.ran).toBe(true);
    expect(result.skippedReason).toContain("Automation");
    expect(updateSession).not.toHaveBeenCalled();
  });

  test("classifies and persists a binding for every live attachment", async () => {
    const boundClaim = makeClaim({
      id: "c1",
      subjectId: "session-bound",
      pid: process.pid,
      terminalContext: { TERM_PROGRAM: "iTerm.app", TERM_SESSION_ID: "w0t0p0:LIVE" },
    });
    const closedTabClaim = makeClaim({
      id: "c2",
      subjectId: "session-closed-tab",
      pid: process.pid,
      terminalContext: { TERM_PROGRAM: "iTerm.app", TERM_SESSION_ID: "w0t0p0:CLOSED" },
    });
    const nonItermClaim = makeClaim({
      id: "c3",
      subjectId: "session-tmux",
      pid: process.pid,
      terminalContext: { TMUX_PANE: "%3" },
    });
    const repo = makeFakeRepo({
      listAllForKind: mock(async () => [boundClaim, closedTabClaim, nonItermClaim]),
    });
    const executor = makeExecutor({ exitCode: 0, stdout: "w0t0p0:LIVE\n", stderr: "" });
    const updateSession = mock(async () => {});

    const result = await runItermCorrelationPass({
      sessionProvider: { updateSession },
      presenceRepo: repo,
      executor,
      platformOverride: "darwin",
    });

    expect(result.ran).toBe(true);
    expect(result.updated).toHaveLength(3);

    expect(updateSession).toHaveBeenCalledWith("session-bound", {
      interfaceBinding: expect.objectContaining({ kind: "iterm-tab", surfaceId: "w0t0p0:LIVE" }),
    });
    expect(updateSession).toHaveBeenCalledWith("session-closed-tab", {
      interfaceBinding: expect.objectContaining({ kind: "unbound" }),
    });
    expect(updateSession).toHaveBeenCalledWith("session-tmux", {
      interfaceBinding: expect.objectContaining({ kind: "unbound" }),
    });
  });
});
