/**
 * Tests for the attached/detached annotation helper (mt#2284).
 */
import { describe, test, expect, mock } from "bun:test";
import {
  annotateSessionsWithAttachment,
  annotateSessionWithAttachment,
} from "./attachment-annotation";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";

function makeFakeDbWithRows(rows: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
  };
  return { select: mock(() => chain) };
}

function makeGetPersistenceProvider(db: unknown): () => PersistenceProvider | undefined {
  const sqlProvider = {
    getDatabaseConnection: mock(async () => db),
  } as unknown as SqlCapablePersistenceProvider;
  return () => sqlProvider as unknown as PersistenceProvider;
}

function makeClaimRow(sessionId: string) {
  return {
    id: `claim-${sessionId}`,
    subjectKind: "session",
    subjectId: sessionId,
    actorId: "actor-1",
    ccConversationId: null,
    tty: null,
    host: null,
    sessionId: null,
    projectId: null,
    pid: null,
    entrypoint: null,
    terminalContext: null,
    claimedAt: new Date("2026-01-01T00:00:00Z"),
    lastRefreshedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("annotateSessionsWithAttachment", () => {
  test("marks sessions with a stored attachment as attached: true, others as false", async () => {
    const db = makeFakeDbWithRows([makeClaimRow("s1")]);
    const getPersistenceProvider = makeGetPersistenceProvider(db);

    const sessions = [{ sessionId: "s1" }, { sessionId: "s2" }];
    const result = await annotateSessionsWithAttachment(sessions, getPersistenceProvider);

    expect(result.find((s) => s.sessionId === "s1")?.attached).toBe(true);
    expect(result.find((s) => s.sessionId === "s2")?.attached).toBe(false);
  });

  test("leaves sessions unannotated (no `attached` field) when persistence is unavailable", async () => {
    const sessions = [{ sessionId: "s1" }];
    const result = await annotateSessionsWithAttachment(sessions, undefined);

    expect(result).toEqual(sessions);
    expect((result[0] as { attached?: boolean }).attached).toBeUndefined();
  });

  test("leaves sessions unannotated when the DB read throws (never blocks the caller)", async () => {
    const sqlProvider = {
      getDatabaseConnection: mock(async () => {
        throw new Error("boom");
      }),
    } as unknown as SqlCapablePersistenceProvider;
    const getPersistenceProvider = () => sqlProvider as unknown as PersistenceProvider;

    const sessions = [{ sessionId: "s1" }];
    const result = await annotateSessionsWithAttachment(sessions, getPersistenceProvider);

    expect(result).toEqual(sessions);
  });
});

describe("annotateSessionWithAttachment", () => {
  test("annotates a single session record", async () => {
    const db = makeFakeDbWithRows([makeClaimRow("s1")]);
    const getPersistenceProvider = makeGetPersistenceProvider(db);

    const result = await annotateSessionWithAttachment({ sessionId: "s1" }, getPersistenceProvider);

    expect(result.attached).toBe(true);
  });
});
