#!/usr/bin/env bun
/**
 * mt#2752 live-verification artifact (implement-task §7a): exercise
 * `writeDrivenSpawnLink` against the REAL Postgres database — the one
 * behavior no unit test covers is the FK relationship between the
 * `agent_transcripts` stub upsert and the `minsky_session_links` insert
 * (the writer's whole reason for the two-step ordering).
 *
 * What it does (bounded + self-cleaning — no lasting rows):
 *   1. Writes a driven_spawn link for a SYNTHETIC harness session id
 *      (`driven-verify-<random>` prefix — cannot collide with a real
 *      Claude Code UUID) and a synthetic workspace id.
 *   2. Reads both rows back and asserts the link row landed with
 *      link_type='driven_spawn', confidence=1.0 (proving the FK stub
 *      ordering worked against the real constraint).
 *   3. Deletes the link row, then the stub transcript row (FK order in
 *      reverse), and verifies both are gone.
 *
 * Run:
 *   bun scripts/verify-driven-link-writer.ts
 *
 * Env-gated: requires the standard Minsky Postgres config (same DI-container
 * load as scripts/backfill-subagent-spawn-links.ts). Exits with a clear SKIP
 * message (exit 0) when the DB is unavailable; exits 1 on any assertion
 * failure. Structured JSON result on stdout.
 *
 * @see packages/domain/src/transcripts/driven-link-writer.ts — module under test
 * @see mt#2752 — Rung 2C (spawn-time identity registration)
 */

import "reflect-metadata";
import { randomUUID } from "crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

async function getDb(): Promise<PostgresJsDatabase> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("Verification requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("Verification requires a SQL-capable persistence provider (Postgres).");
  }

  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Verification requires an initialized Postgres database connection.");
  }

  return connection as PostgresJsDatabase;
}

async function main(): Promise<void> {
  let db: PostgresJsDatabase;
  try {
    db = await getDb();
  } catch (err) {
    console.error(
      "SKIP: failed to initialize DB connection — Postgres not available in this environment."
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(0);
  }

  const { writeDrivenSpawnLink, DRIVEN_SPAWN_LINK_TYPE, DRIVEN_SPAWN_CONFIDENCE } = await import(
    "@minsky/domain/transcripts/driven-link-writer"
  );
  const { agentTranscriptsTable } = await import(
    "@minsky/domain/storage/schemas/agent-transcripts-schema"
  );
  const { minskySessionLinksTable } = await import(
    "@minsky/domain/storage/schemas/minsky-session-links-schema"
  );
  const { eq, and } = await import("drizzle-orm");

  // Synthetic, collision-proof ids — a real harness session id is a bare
  // UUID; the prefix guarantees this row can only be ours.
  const agentSessionId = `driven-verify-${randomUUID()}`;
  const minskySessionId = `driven-verify-ws-${randomUUID()}`;
  const cwd = `/tmp/driven-verify/${minskySessionId}`;
  const startedAt = new Date().toISOString();

  const result: Record<string, unknown> = { agentSessionId, minskySessionId };
  let failed = false;

  // 1. Write (stub upsert then link insert — the FK-ordered path under test).
  const outcome = await writeDrivenSpawnLink(db, {
    agentSessionId,
    minskySessionId,
    cwd,
    startedAt,
  });
  result.writeOutcome = outcome;
  if (outcome !== "written") failed = true;

  // 2. Read back both rows.
  const stubRows = await db
    .select({ harness: agentTranscriptsTable.harness, cwd: agentTranscriptsTable.cwd })
    .from(agentTranscriptsTable)
    .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId as never));
  result.stubRowFound = stubRows.length === 1;
  result.stubRow = stubRows[0] ?? null;
  if (stubRows.length !== 1) failed = true;

  const linkRows = await db
    .select({
      linkType: minskySessionLinksTable.linkType,
      confidence: minskySessionLinksTable.confidence,
    })
    .from(minskySessionLinksTable)
    .where(
      and(
        eq(minskySessionLinksTable.agentSessionId, agentSessionId),
        eq(minskySessionLinksTable.minskySessionId, minskySessionId)
      )
    );
  result.linkRowFound = linkRows.length === 1;
  result.linkRow = linkRows[0] ?? null;
  if (
    linkRows.length !== 1 ||
    linkRows[0]?.linkType !== DRIVEN_SPAWN_LINK_TYPE ||
    linkRows[0]?.confidence !== DRIVEN_SPAWN_CONFIDENCE
  ) {
    failed = true;
  }

  // 3. Cleanup — reverse FK order — and verify both rows are gone.
  await db
    .delete(minskySessionLinksTable)
    .where(
      and(
        eq(minskySessionLinksTable.agentSessionId, agentSessionId),
        eq(minskySessionLinksTable.minskySessionId, minskySessionId)
      )
    );
  await db
    .delete(agentTranscriptsTable)
    .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId as never));

  const stubAfter = await db
    .select({ harness: agentTranscriptsTable.harness })
    .from(agentTranscriptsTable)
    .where(eq(agentTranscriptsTable.agentSessionId, agentSessionId as never));
  const linkAfter = await db
    .select({ linkType: minskySessionLinksTable.linkType })
    .from(minskySessionLinksTable)
    .where(eq(minskySessionLinksTable.agentSessionId, agentSessionId));
  result.cleanupComplete = stubAfter.length === 0 && linkAfter.length === 0;
  if (!result.cleanupComplete) failed = true;

  result.pass = !failed;
  console.log(JSON.stringify(result, null, 2));
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Verification crashed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
