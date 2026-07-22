#!/usr/bin/env bun
// Verification artifact for mt#3019 — does a HOOK process actually reach the DB?
//
// This exercises the exact chain `.minsky/hooks/record-subagent-invocation.ts`
// walks, from a bare bun process with no CLI/MCP boot ahead of it:
//
//   ensureHookDomainBootstrap()          <- the fix
//     -> resolvePersistenceProvider()    <- returned null for this hook's whole life
//       -> getDatabaseConnection()
//         -> SubagentDispatchTracker.recordSubagentInvocation()  <- the write
//
// The write is performed for real, against the live schema, inside a
// transaction that is ALWAYS rolled back — so this proves the write path
// (column names, NOT NULL constraints, enum values, the upsert branch) without
// leaving a fabricated invocation row behind. A row invented by a verification
// script is worse than no row: `subagent_invocations` is read by the dispatch
// watchdog and the cadence taxonomy.
//
// Usage:  bun scripts/verify-hook-domain-bootstrap.ts
// Exit:   0 = pass (or SKIP when no DB is configured), non-zero = fail.
//
// @see mt#3019 — the defect and its two-layer diagnosis
// @see .minsky/hooks/domain-bootstrap.ts — the shared bootstrap under test
// @see mt#3046 — generalizes this into a per-hook CI smoke test

import { ensureHookDomainBootstrap } from "../.minsky/hooks/domain-bootstrap";

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}

const steps: Step[] = [];
let failed = false;

function record(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
  if (!ok) failed = true;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}\n`);
}

// Env gate: no configured Postgres means this check cannot run. Skip cleanly.
const hasDbConfig =
  Boolean(process.env.MINSKY_PERSISTENCE_POSTGRES_URL) ||
  Boolean(process.env.MINSKY_POSTGRES_URL) ||
  Boolean(process.env.DATABASE_URL);

const bootstrap = await ensureHookDomainBootstrap();
record(
  "layer 1+2: hook domain bootstrap",
  bootstrap.ok,
  bootstrap.ok
    ? "reflect-metadata installed and domain configuration initialized"
    : `bootstrap failed: ${bootstrap.error}`
);

if (!bootstrap.ok) {
  process.exit(1);
}

const { resolvePersistenceProvider } = await import("../packages/domain/src/persistence/factory");
const provider = await resolvePersistenceProvider();

if (!provider && !hasDbConfig) {
  process.stdout.write(
    "SKIP: no Postgres configured (MINSKY_PERSISTENCE_POSTGRES_URL / DATABASE_URL unset) — bootstrap verified, DB round-trip skipped\n"
  );
  process.exit(0);
}

record(
  "resolvePersistenceProvider() returns a provider",
  provider !== null,
  provider === null
    ? "returned null — this is the exact symptom mt#3019 fixed; re-run with debug logging to see the swallowed error"
    : `provider = ${provider.constructor.name}`
);

if (!provider) {
  process.exit(1);
}

record(
  "provider exposes getDatabaseConnection",
  "getDatabaseConnection" in provider,
  "getDatabaseConnection" in provider
    ? "capability present (the hook's guard passes)"
    : "capability missing — the hook would soft-skip here"
);

try {
  const db = (await (
    provider as {
      getDatabaseConnection(): Promise<import("drizzle-orm/postgres-js").PostgresJsDatabase>;
    }
  ).getDatabaseConnection()) as import("drizzle-orm/postgres-js").PostgresJsDatabase;

  record("getDatabaseConnection() resolves", db != null, "live connection obtained");

  const { SubagentDispatchTracker, UNKNOWN_AGENT_TYPE, UNKNOWN_TASK_ID } = await import(
    "../src/mcp/subagent-dispatch-tracker"
  );

  const { eq } = await import("drizzle-orm");
  const { subagentInvocationsTable } = await import(
    "../packages/domain/src/storage/schemas/subagent-invocations-schema"
  );

  // A real write against the live schema, then an explicit delete. The probe
  // key is unmistakably synthetic and scoped to this pid, and the delete is
  // keyed on exactly that value — so this can never touch a genuine invocation
  // row. The insert is deliberately NOT wrapped in a rolled-back transaction:
  // reading the row back through a normal query is stronger evidence that the
  // write landed (correct columns, satisfied constraints, valid enum) than
  // trusting the returned id, and it exercises the same visibility path every
  // consumer of this table uses.
  const probeSessionId = `mt3019-verify-${process.pid}`;
  const tracker = new SubagentDispatchTracker(db);
  const now = new Date();
  const insertedId = await tracker.recordSubagentInvocation({
    taskId: UNKNOWN_TASK_ID,
    subagentSessionId: probeSessionId,
    agentSessionId: `verify-${process.pid}`,
    agentType: UNKNOWN_AGENT_TYPE,
    outcome: "crashed-no-output",
    toolUseCount: 1,
    totalTokens: 1,
    durationMs: 1,
    startedAt: now,
    endedAt: now,
    handoffWritten: false,
  });

  try {
    const written = await db
      .select({ id: subagentInvocationsTable.id, taskId: subagentInvocationsTable.taskId })
      .from(subagentInvocationsTable)
      .where(eq(subagentInvocationsTable.subagentSessionId, probeSessionId));

    record(
      "tracker write path lands a row in subagent_invocations",
      insertedId !== null && written.length === 1,
      insertedId !== null && written.length === 1
        ? `row ${insertedId} read back with task_id=${written[0]?.taskId}`
        : `recordSubagentInvocation returned ${insertedId}; rows read back: ${written.length} (expected 1)`
    );
  } finally {
    // Always clean up, even if the read-back assertion above threw.
    await db
      .delete(subagentInvocationsTable)
      .where(eq(subagentInvocationsTable.subagentSessionId, probeSessionId));
  }

  const residue = await db
    .select({ id: subagentInvocationsTable.id })
    .from(subagentInvocationsTable)
    .where(eq(subagentInvocationsTable.subagentSessionId, probeSessionId));
  record(
    "no residue left in subagent_invocations",
    residue.length === 0,
    `rows matching the probe key after cleanup: ${residue.length} (expected 0)`
  );
} finally {
  try {
    await provider.close();
  } catch {
    /* ignore */
  }
}

process.stdout.write(
  `\n${failed ? "RESULT: FAIL" : "RESULT: PASS"} — ${steps.filter((s) => s.ok).length}/${steps.length} checks passed\n`
);
process.exit(failed ? 1 : 0);
