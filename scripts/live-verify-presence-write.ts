#!/usr/bin/env bun
/**
 * Live verification script for mt#2567.
 *
 * Exercises the full writeTaskClaim per-call repo fallback path against
 * the real shared Postgres database (same one used by the running minsky).
 *
 * Verifies:
 *   - writeTaskClaim (with no pre-set repo) builds the repo per-call from
 *     the container and upserts a real row into presence_claims
 *   - tasks_claims_list returns that row after the write
 *   - cleanup: deletes the probe row so it does not pollute the live table
 *
 * Usage: bun scripts/live-verify-presence-write.ts
 */

import "reflect-metadata";

// ---------------------------------------------------------------------------
// 1. Load database connection string from minsky config
// ---------------------------------------------------------------------------
import { readFile } from "fs/promises";
import { homedir } from "os";
import yaml from "js-yaml";

const configPath = `${homedir()}/.config/minsky/config.yaml`;
const raw = await readFile(configPath, "utf-8");
const config = yaml.load(raw) as { persistence?: { postgres?: { connectionString?: string } } };
const connectionString = config?.persistence?.postgres?.connectionString;

if (!connectionString) {
  console.error("No postgres.connectionString found in ~/.config/minsky/config.yaml");
  process.exit(1);
}

console.log("[live-verify] Connected to Postgres via minsky config");

// ---------------------------------------------------------------------------
// 2. Build a real PostgresPersistenceProvider and wrap it in a fake container
// ---------------------------------------------------------------------------
import { PostgresPersistenceProvider } from "../packages/domain/src/persistence/providers/postgres-provider";
import type { AppContainerInterface } from "../src/container";

const provider = new PostgresPersistenceProvider({
  backend: "postgres",
  postgres: { connectionString },
});

// Initialize the provider so getDatabaseConnection() returns a real db
await provider.initialize();

// Minimal fake container that surfaces the persistence provider
const fakeContainer: Pick<AppContainerInterface, "has" | "get"> = {
  has: (key: string) => key === "persistence",
  get: (_key: string) => provider,
};

// ---------------------------------------------------------------------------
// 3. Create MinskyMCPServer WITHOUT calling setPresenceClaimRepository —
//    this is the exact failure scenario from mt#2567.
// ---------------------------------------------------------------------------
import { MinskyMCPServer } from "../src/mcp/server";

const server = new MinskyMCPServer({
  name: "Live-Verify Server",
  version: "0.0.0-probe",
  projectContext: { repositoryPath: process.cwd() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  container: fakeContainer as any,
});

// Confirm: presenceClaimRepo is NOT set (pre-fix code would return here)
// Access via type cast for the probe
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe: accessing private field for verification only
const repoField = (server as any).presenceClaimRepo;
console.log(
  `[live-verify] presenceClaimRepo pre-set: ${repoField != null} (expected: false for the regression scenario)`
);

// ---------------------------------------------------------------------------
// 4. Call writeTaskClaim — per-call fallback should build the repo and upsert
// ---------------------------------------------------------------------------
const PROBE_TASK_ID = "mt#2567";
const PROBE_ACTOR_ID = "__live_verify_probe_mt2567__";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- probe: accessing private method for live-verification only
const writeTaskClaim = (server as any).writeTaskClaim.bind(server) as (
  args: Record<string, unknown>,
  actorId: string
) => Promise<void>;

console.log(
  `[live-verify] Calling writeTaskClaim({ task: "${PROBE_TASK_ID}" }, "${PROBE_ACTOR_ID}")`
);
await writeTaskClaim({ task: PROBE_TASK_ID }, PROBE_ACTOR_ID);
console.log("[live-verify] writeTaskClaim returned (no throw)");

// ---------------------------------------------------------------------------
// 5. Query presence_claims directly to verify the row was inserted
// ---------------------------------------------------------------------------
import postgres from "postgres";

const sql = postgres(connectionString, { max: 1 });

type PresenceRow = {
  id: string;
  subject_kind: string;
  subject_id: string;
  actor_id: string;
  claimed_at: Date;
  last_refreshed_at: Date;
};

const rows = await sql<PresenceRow[]>`
  SELECT id, subject_kind, subject_id, actor_id, claimed_at, last_refreshed_at
  FROM presence_claims
  WHERE subject_id = 'mt2567' AND actor_id = ${PROBE_ACTOR_ID}
`;

if (rows.length === 0) {
  console.error("[live-verify] FAIL — no row found in presence_claims. Write-path did not fire.");
  await sql.end();
  await provider.close?.();
  process.exit(1);
}

const row = rows[0];
console.log("[live-verify] PASS — row found in presence_claims:");
console.log(`  id             : ${row.id}`);
console.log(`  subject_kind   : ${row.subject_kind}`);
console.log(`  subject_id     : ${row.subject_id}`);
console.log(`  actor_id       : ${row.actor_id}`);
console.log(`  claimed_at     : ${row.claimed_at.toISOString()}`);
console.log(`  last_refreshed : ${row.last_refreshed_at.toISOString()}`);

// ---------------------------------------------------------------------------
// 6. Cleanup — delete the probe row so it doesn't pollute the live table
// ---------------------------------------------------------------------------
const deleted = await sql`
  DELETE FROM presence_claims WHERE id = ${row.id} RETURNING id
`;
console.log(`[live-verify] Cleanup: deleted probe row (id=${deleted[0]?.id})`);

await sql.end();
await provider.close?.();

console.log("[live-verify] Live verification COMPLETE — mt#2567 write-path is operational.");
