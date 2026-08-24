#!/usr/bin/env bun
/**
 * READ-ONLY diagnosis for mt#4469: why did 464 `subagent_spawn` link writes fail?
 *
 * `writeSpawnLink` (packages/domain/src/transcripts/spawn-link-writer.ts) inserts into
 * `minsky_session_links`, whose `agent_session_id` column carries an ENFORCED foreign key to
 * `agent_transcripts.agent_session_id`. It writes the CHILD's agent session id there.
 *
 * Spawn resolution yields a child *id*; it does not guarantee that child's transcript was ever
 * INGESTED. So a resolved child with no `agent_transcripts` row makes the insert violate the FK,
 * which `writeSpawnLink` catches, logs via `log.warn` — the sink the CLI discards — and counts as
 * `spawnLinksErrored`.
 *
 * This script tests that hypothesis WITHOUT writing anything and without re-running the corpus
 * sweep (a bulk production write whose authorization is consumed — see mt#4469).
 *
 * Executes SELECTs only. No INSERT/UPDATE/DELETE, no DDL.
 */
import "reflect-metadata";
import { sql } from "drizzle-orm";

async function bootstrapDb() {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
  const container = await createCliContainer();
  await container.initialize();
  const persistence = container.get("persistence") as {
    getDatabaseConnection: () => Promise<{ execute: (q: unknown) => Promise<unknown> }>;
  };
  return persistence.getDatabaseConnection();
}

const db = await bootstrapDb();

// The population the pipeline calls "resolved child", split by whether that child's transcript
// exists in agent_transcripts — i.e. whether the FK would accept the link row.
const population = await db.execute(sql`
  SELECT
    count(*)                                                            AS spawn_rows,
    count(*) FILTER (WHERE s.child_agent_session_id IS NOT NULL)        AS resolved_child,
    count(*) FILTER (
      WHERE s.child_agent_session_id IS NOT NULL AND t.agent_session_id IS NULL
    )                                                                   AS child_not_ingested,
    count(DISTINCT s.child_agent_session_id) FILTER (
      WHERE s.child_agent_session_id IS NOT NULL AND t.agent_session_id IS NULL
    )                                                                   AS distinct_missing_children
  FROM agent_spawns s
  LEFT JOIN agent_transcripts t ON t.agent_session_id = s.child_agent_session_id
`);

// How many subagent_spawn links actually landed, for scale.
const links = await db.execute(sql`
  SELECT link_type, count(*) AS n
  FROM minsky_session_links
  GROUP BY link_type
  ORDER BY n DESC
`);

console.log("=== agent_spawns population (FK acceptance for the link write) ===");
console.log(JSON.stringify(population, null, 2));
console.log("\n=== minsky_session_links by link_type ===");
console.log(JSON.stringify(links, null, 2));

process.exit(0);
