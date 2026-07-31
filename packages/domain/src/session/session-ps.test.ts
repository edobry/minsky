/**
 * Tests for the `session ps` report builder (mt#2284): joins stored
 * self-registered attachments with the local lsof cross-check and reports
 * stored-but-not-live / live-but-not-stored discrepancies distinctly.
 */

import { describe, test, expect, mock } from "bun:test";
import type { PresenceClaim, PresenceClaimRepository } from "../presence/index";
import { buildSessionPsReport } from "./session-ps";

const SESSIONS_DIR = "/Users/edobry/.local/state/minsky/sessions";

function makeClaim(overrides: Partial<PresenceClaim>): PresenceClaim {
  return {
    id: "claim",
    subjectKind: "session",
    subjectId: "session-a",
    actorId: "actor-1",
    claimedAt: "2026-07-15T00:00:00.000Z",
    lastRefreshedAt: "2026-07-15T00:05:00.000Z",
    ...overrides,
  };
}

function makeRepo(claims: PresenceClaim[]): PresenceClaimRepository {
  return {
    upsertClaim: mock(async () => claims[0] ?? makeClaim({})),
    listClaims: mock(async () => []),
    reapStale: mock(async () => 0),
    listAllForKind: mock(async () => claims),
    deleteBySubject: mock(async () => 0),
    deleteByIds: mock(async () => 0),
  };
}

describe("buildSessionPsReport", () => {
  test("a matching stored attachment + live process reports no discrepancy", async () => {
    const claim = makeClaim({ id: "c1", subjectId: "session-a", pid: 100 });
    const repo = makeRepo([claim]);
    const lsofRunner = async () => `p100\nfcwd\nn${SESSIONS_DIR}/session-a`;

    const report = await buildSessionPsReport(repo, SESSIONS_DIR, lsofRunner);

    expect(report).toHaveLength(1);
    expect(report[0].sessionId).toBe("session-a");
    expect(report[0].attachments).toHaveLength(1);
    expect(report[0].liveProcesses).toHaveLength(1);
    expect(report[0].storedNotLive).toEqual([]);
    expect(report[0].liveNotStored).toEqual([]);
  });

  test("stored-but-not-live: a self-registered attachment whose pid is not among live processes", async () => {
    const claim = makeClaim({ id: "c1", subjectId: "session-a", pid: 999999999 });
    const repo = makeRepo([claim]);
    const lsofRunner = async () => ""; // nothing live

    const report = await buildSessionPsReport(repo, SESSIONS_DIR, lsofRunner);

    expect(report).toHaveLength(1);
    expect(report[0].storedNotLive).toHaveLength(1);
    expect(report[0].storedNotLive[0].id).toBe("c1");
    expect(report[0].liveNotStored).toEqual([]);
  });

  test("live-but-not-stored: a shell hand-cd'd into a session workspace with no self-registration", async () => {
    const repo = makeRepo([]); // no stored attachments at all
    const lsofRunner = async () => `p200\nfcwd\nn${SESSIONS_DIR}/session-b`;

    const report = await buildSessionPsReport(repo, SESSIONS_DIR, lsofRunner);

    expect(report).toHaveLength(1);
    expect(report[0].sessionId).toBe("session-b");
    expect(report[0].attachments).toEqual([]);
    expect(report[0].liveNotStored).toHaveLength(1);
    expect(report[0].liveNotStored[0].pid).toBe(200);
    expect(report[0].storedNotLive).toEqual([]);
  });

  test("an attachment with no recorded pid is never flagged stored-not-live (nothing to cross-check)", async () => {
    const claim = makeClaim({ id: "c1", subjectId: "session-a", pid: undefined });
    const repo = makeRepo([claim]);
    const lsofRunner = async () => "";

    const report = await buildSessionPsReport(repo, SESSIONS_DIR, lsofRunner);

    expect(report[0].storedNotLive).toEqual([]);
  });

  test("returns an empty report when there is nothing stored and nothing live", async () => {
    const repo = makeRepo([]);
    const lsofRunner = async () => "";

    const report = await buildSessionPsReport(repo, SESSIONS_DIR, lsofRunner);

    expect(report).toEqual([]);
  });
});
