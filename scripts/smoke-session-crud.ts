#!/usr/bin/env bun
/**
 * Smoke test for the DrizzleSessionRepository session-CRUD path (mt#2329).
 *
 * Exercises create -> read -> getByTaskId -> update -> list -> workdir -> delete
 * (+ idempotent re-delete) against BOTH:
 *   - FakeSessionProvider (always; hermetic), and
 *   - DrizzleSessionRepository over the configured Postgres backend (gated).
 *
 * Gating: if no persistence provider resolves (no Postgres configured), the
 * Postgres leg SKIPs gracefully (exit 0). The Fake leg always runs. Emits a
 * single JSON line on stdout; exits 0 on pass/skip, non-zero on failure.
 *
 * Run: bun scripts/smoke-session-crud.ts
 */
import "reflect-metadata";
import { initializeConfiguration, CustomConfigFactory } from "@minsky/domain/configuration";
import { resolvePersistenceProvider } from "@minsky/domain/persistence/factory";
import { DrizzleSessionRepository } from "@minsky/domain/session/drizzle-session-repository";
import { FakeSessionProvider } from "@minsky/domain/session/fake-session-provider";
import type { SessionProviderInterface, SessionRecord } from "@minsky/domain/session/types";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const SID = `smoke-mt2329-${process.pid}-${Math.floor(performance.now())}`;
// A high, synthetic, qualified task id that will not collide with a real session
// (real session taskIds are stored qualified, e.g. "mt#971"). Using the live
// "mt#2329" here would collide with this migration's own session.
const TASK_ID = `mt#${8_000_000 + (process.pid % 1_000_000)}`;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function makeRecord(): SessionRecord {
  return {
    sessionId: SID,
    repoName: "minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: TASK_ID,
  };
}

async function exerciseCrud(
  provider: SessionProviderInterface,
  label: string,
  derivedWorkdir: boolean
): Promise<void> {
  await provider.addSession(makeRecord());

  const got = await provider.getSession(SID);
  assert(got?.sessionId === SID, `${label}: getSession returns the created record`);
  assert(got?.taskId === TASK_ID, `${label}: taskId preserved on read`);

  const byTask = await provider.getSessionByTaskId(TASK_ID);
  assert(byTask?.sessionId === SID, `${label}: getSessionByTaskId locates the record`);

  await provider.updateSession(SID, { agentId: "smoke-agent", commitCount: 7 });
  const updated = await provider.getSession(SID);
  assert(updated?.agentId === "smoke-agent", `${label}: update applied`);
  assert(updated?.commitCount === 7, `${label}: numeric update applied`);
  assert(updated?.repoName === "minsky", `${label}: update preserves untouched fields`);

  const list = await provider.listSessions();
  assert(
    list.some((s) => s.sessionId === SID),
    `${label}: listSessions includes the record`
  );

  // R1 BLOCKING regression: listSessions({ taskId }) must find the record by its
  // qualified task id (previously the prefix-strip made this filter a no-op).
  const byTaskList = await provider.listSessions({ taskId: TASK_ID });
  assert(
    byTaskList.some((s) => s.sessionId === SID),
    `${label}: listSessions({ taskId }) finds the record`
  );

  const workdir = await provider.getSessionWorkdir(SID);
  if (derivedWorkdir) {
    assert(workdir.endsWith(`/sessions/${SID}`), `${label}: getSessionWorkdir derives the path`);
  } else {
    assert(
      typeof workdir === "string" && workdir.length > 0,
      `${label}: getSessionWorkdir returns a path`
    );
  }

  const deleted = await provider.deleteSession(SID);
  assert(deleted === true, `${label}: deleteSession returns true`);
  const gone = await provider.getSession(SID);
  assert(gone === null, `${label}: getSession returns null after delete`);
  const deletedAgain = await provider.deleteSession(SID);
  assert(deletedAgain === false, `${label}: idempotent re-delete returns false`);
}

async function main(): Promise<void> {
  const results: Record<string, string> = { fake: "skip", postgres: "skip" };

  // Fake leg — always runs (hermetic). The Fake returns a fixed mock workdir,
  // so the derived-path shape check is skipped for it.
  await exerciseCrud(new FakeSessionProvider(), "FakeSessionProvider", false);
  results.fake = "pass";

  // Postgres leg — gated on a resolvable persistence provider.
  let provider: Awaited<ReturnType<typeof resolvePersistenceProvider>> | null = null;
  try {
    await initializeConfiguration(new CustomConfigFactory());
    provider = await resolvePersistenceProvider();
  } catch {
    provider = null;
  }
  if (!provider) {
    console.log(
      JSON.stringify({ event: "smoke.skip", reason: "no persistence provider configured", results })
    );
    return;
  }

  try {
    const db = (await provider.getDatabaseConnection?.()) as PostgresJsDatabase | undefined;
    if (!db) {
      console.log(
        JSON.stringify({ event: "smoke.skip", reason: "provider has no SQL connection", results })
      );
      return;
    }
    const repo = new DrizzleSessionRepository(db);
    try {
      await exerciseCrud(repo, "DrizzleSessionRepository", true);
      results.postgres = "pass";
    } catch (err) {
      // Best-effort cleanup of the smoke row before re-throwing.
      try {
        await repo.deleteSession(SID);
      } catch {
        /* ignore cleanup error */
      }
      throw err;
    }
  } finally {
    try {
      await provider.close();
    } catch {
      /* ignore close error */
    }
  }

  console.log(JSON.stringify({ event: "smoke.pass", results }));
}

main().catch((e) => {
  console.error(JSON.stringify({ event: "smoke.fail", error: String(e?.message ?? e) }));
  process.exit(1);
});
