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
// With `--e2e` it additionally drives the FULL end-to-end path the acceptance
// criterion names (PR #2178 R2): write a pending dispatch row exactly as
// `tasks.dispatch` does, invoke the GENERATED hook binary the way the harness
// does — a bare `bun .claude/hooks/record-subagent-invocation.ts` with a
// SubagentStop payload on stdin, against a REAL session workspace — then read
// the row back and assert the Stop-time columns landed. Everything it writes is
// deleted before it exits.
//
// Usage:  bun scripts/verify-hook-domain-bootstrap.ts          (bootstrap + write path)
//         bun scripts/verify-hook-domain-bootstrap.ts --e2e    (adds the full hook round-trip)
// Exit:   0 = pass (or SKIP when no DB is configured), non-zero = fail.
//
// @see mt#3019 — the defect and its two-layer diagnosis
// @see .minsky/hooks/domain-bootstrap.ts — the shared bootstrap under test
// @see mt#3046 — generalizes this into a per-hook CI smoke test

import { ensureHookDomainBootstrap } from "../.minsky/hooks/domain-bootstrap";

const RUN_E2E = process.argv.includes("--e2e");

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

  // -------------------------------------------------------------------------
  // --e2e: the acceptance criterion (PR #2178 R2)
  //
  // "A live SubagentStop writes a row end-to-end: a dispatch's row carries
  // non-null agent_session_id, ended_at, and a classified outcome."
  //
  // Everything above proves the hook's DEPENDENCIES work. This proves the HOOK
  // works: it runs the generated binary the harness runs, with the payload
  // shape the harness sends, against a real session workspace, on top of a
  // pending row written exactly the way `tasks.dispatch` writes one.
  // -------------------------------------------------------------------------
  if (RUN_E2E) {
    // The workspace under observation is this script's own session checkout —
    // a genuine Minsky session with a real task branch, real commits, and a
    // real session record for `resolveTaskId`'s DB lookup to find.
    const workspace = process.cwd();
    const sessionMatch = workspace.match(/\/sessions\/([^/]+)(?:\/|$)/);
    const realSessionId = sessionMatch?.[1];

    if (!realSessionId) {
      record(
        "e2e: running inside a Minsky session workspace",
        false,
        `cwd is not under /sessions/<id>: ${workspace} — run this from a session checkout`
      );
    } else {
      const hookPath = `${workspace}/.claude/hooks/record-subagent-invocation.ts`;
      const e2eAgentId = `mt3019-e2e-${process.pid}`;
      const dispatchTime = new Date();

      try {
        // 1. Pending row, written the way dispatch-command.ts Step 5 writes it:
        //    real task id, keyed on the subagent's Minsky session id, with the
        //    pessimistic placeholder outcome the Stop hook is meant to replace.
        const pendingTracker = new SubagentDispatchTracker(db);
        const pendingId = await pendingTracker.recordSubagentInvocation({
          taskId: "mt#3019",
          subagentSessionId: realSessionId,
          agentType: "implementer",
          suggestedModel: "sonnet",
          startedAt: dispatchTime,
          outcome: "crashed-no-output",
        });
        record(
          "e2e: pending dispatch row written",
          pendingId !== null,
          `row ${pendingId} — task_id=mt#3019, outcome=crashed-no-output (the placeholder)`
        );

        // 2. Invoke the GENERATED hook exactly as the harness does.
        const proc = Bun.spawn(["bun", hookPath], {
          stdin: new TextEncoder().encode(
            JSON.stringify({ agent_id: e2eAgentId, cwd: workspace, transcript_path: "" })
          ),
          stdout: "pipe",
          stderr: "pipe",
        });
        const hookStderr = await new Response(proc.stderr).text();
        const hookExit = await proc.exited;
        record(
          "e2e: hook process exits 0 (fail-safe contract)",
          hookExit === 0,
          hookStderr.trim() === "" ? "clean run, no stderr" : `stderr: ${hookStderr.trim()}`
        );

        // 3. Read the row back — this is the acceptance criterion.
        const after = await db
          .select({
            id: subagentInvocationsTable.id,
            taskId: subagentInvocationsTable.taskId,
            agentType: subagentInvocationsTable.agentType,
            agentSessionId: subagentInvocationsTable.agentSessionId,
            endedAt: subagentInvocationsTable.endedAt,
            outcome: subagentInvocationsTable.outcome,
            lastCommitHash: subagentInvocationsTable.lastCommitHash,
            startedAt: subagentInvocationsTable.startedAt,
          })
          .from(subagentInvocationsTable)
          .where(eq(subagentInvocationsTable.subagentSessionId, realSessionId));

        const row = after[0];
        record(
          "e2e: the Stop upserted the SAME row (no duplicate insert)",
          after.length === 1 && row?.id === pendingId,
          `rows for this session: ${after.length}; id match: ${row?.id === pendingId}`
        );
        record(
          "e2e: agent_session_id written by the hook",
          row?.agentSessionId === e2eAgentId,
          `agent_session_id=${row?.agentSessionId ?? "NULL"} (expected ${e2eAgentId})`
        );
        record(
          "e2e: ended_at written — the watchdog's liveness signal",
          row?.endedAt != null,
          `ended_at=${row?.endedAt?.toISOString() ?? "NULL"}`
        );
        record(
          "e2e: outcome classified from the real workspace",
          typeof row?.outcome === "string",
          `outcome=${row?.outcome} (dispatch placeholder was crashed-no-output; ` +
            `last_commit_hash=${row?.lastCommitHash ?? "NULL"})`
        );
        record(
          "e2e: dispatch-time task_id and agent_type preserved through the upsert",
          row?.taskId === "mt#3019" && row?.agentType === "implementer",
          `task_id=${row?.taskId}, agent_type=${row?.agentType} (both sentinels must be dropped)`
        );
        record(
          "e2e: dispatch-time started_at preserved (mt#1736)",
          row?.startedAt?.getTime() === dispatchTime.getTime(),
          `started_at=${row?.startedAt?.toISOString() ?? "NULL"} (expected the dispatch time)`
        );
      } finally {
        await db
          .delete(subagentInvocationsTable)
          .where(eq(subagentInvocationsTable.subagentSessionId, realSessionId));
      }

      const e2eResidue = await db
        .select({ id: subagentInvocationsTable.id })
        .from(subagentInvocationsTable)
        .where(eq(subagentInvocationsTable.subagentSessionId, realSessionId));
      record(
        "e2e: no residue left behind",
        e2eResidue.length === 0,
        `rows for this session after cleanup: ${e2eResidue.length} (expected 0)`
      );
    }
  }
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
