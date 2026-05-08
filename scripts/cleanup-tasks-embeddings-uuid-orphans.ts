#!/usr/bin/env bun
/**
 * cleanup-tasks-embeddings-uuid-orphans
 *
 * Removes orphan rows from `tasks_embeddings` whose `task_id` is UUID-shaped
 * (and therefore cannot be a real Minsky task ID — task IDs are formatted
 * `mt#NNNN`). These are residue from the mt#1605 footgun pattern: callers of
 * the deprecated `getVectorStorage(dimension)` / `createVectorStorageFromConfig`
 * APIs silently routed embeddings into `tasks_embeddings` regardless of caller
 * intent. mt#1605 fixed the structural bug; mt#1611 deleted the deprecated
 * alias entirely. This script is the data-cleanup tail.
 *
 * Origin task: mt#1642
 *
 * Idempotent: re-running after cleanup is a no-op (selects 0 rows, exits 0).
 *
 * Usage:
 *   MINSKY_POSTGRES_URL=postgres://... bun scripts/cleanup-tasks-embeddings-uuid-orphans.ts
 *
 * Env-gated: skips with exit 0 if MINSKY_POSTGRES_URL is not set.
 *
 * Output: structured JSON to stdout summarizing inspection + actions.
 *
 * Pooler note: queries are sequential (no Promise.all). The supabase
 * transaction pooler at port 6543 with max:1 connection serialises all
 * queries; concurrent issuance via Promise.all hangs after the first
 * iteration. Sequential awaits avoid the contention.
 */

import postgres from "postgres";

const UUID_REGEX = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

interface OrphanRow {
  task_id: string;
  indexed_at: string | null;
  vector_size: number;
}

interface CrossRefResult {
  inMemories: boolean;
  inKnowledge: boolean;
  inRules: boolean;
  inTools: boolean;
}

async function crossReference(sql: postgres.Sql, taskId: string): Promise<CrossRefResult> {
  const memories = await sql`SELECT 1 FROM memories_embeddings WHERE memory_id = ${taskId} LIMIT 1`;
  const knowledge =
    await sql`SELECT 1 FROM knowledge_embeddings WHERE document_id = ${taskId} LIMIT 1`;
  const rules = await sql`SELECT 1 FROM rules_embeddings WHERE rule_id = ${taskId} LIMIT 1`;
  const tools = await sql`SELECT 1 FROM tool_embeddings WHERE tool_id = ${taskId} LIMIT 1`;
  return {
    inMemories: memories.length > 0,
    inKnowledge: knowledge.length > 0,
    inRules: rules.length > 0,
    inTools: tools.length > 0,
  };
}

async function main(): Promise<void> {
  const url = process.env.MINSKY_POSTGRES_URL;
  if (!url) {
    console.log(
      JSON.stringify({
        skipped: true,
        reason: "MINSKY_POSTGRES_URL not set",
      })
    );
    process.exit(0);
  }

  const sql = postgres(url, { ssl: "prefer", max: 1 });
  const ranAt = new Date().toISOString();

  try {
    // Step 1: identify all UUID-shaped rows in tasks_embeddings
    const orphans = await sql<OrphanRow[]>`
      SELECT task_id,
             indexed_at::text,
             octet_length(vector::text) AS vector_size
      FROM tasks_embeddings
      WHERE task_id ~ ${UUID_REGEX}
      ORDER BY task_id`;

    if (orphans.length === 0) {
      console.log(
        JSON.stringify(
          {
            ranAt,
            orphansFound: 0,
            action: "no-op (idempotent re-run)",
            passed: true,
          },
          null,
          2
        )
      );
      return;
    }

    // Step 2: cross-reference each row against the other domain tables.
    // Sequential awaits per row (Promise.all hangs against the supabase
    // transaction pooler with max:1).
    const inspected = [];
    for (const row of orphans) {
      const crossRef = await crossReference(sql, row.task_id);
      inspected.push({ ...row, crossRef });
    }

    // Step 3: DELETE all UUID-shaped rows. The DELETE statement itself is
    // atomic at the statement level. We deliberately avoid a sql.begin()
    // wrapper here because that's brittle against the pooler in transaction
    // mode for cross-statement transactions; a single-statement DELETE is
    // sufficient for this cleanup.
    const deleted = await sql`
      DELETE FROM tasks_embeddings
      WHERE task_id ~ ${UUID_REGEX}
      RETURNING task_id`;
    const deletedIds = deleted.map((r) => r.task_id);

    // Step 4: verify post-count is 0.
    const postCount = await sql`
      SELECT COUNT(*)::int AS c
      FROM tasks_embeddings
      WHERE task_id ~ ${UUID_REGEX}`;

    const passed = postCount[0].c === 0;

    console.log(
      JSON.stringify(
        {
          ranAt,
          orphansFound: orphans.length,
          inspected: inspected.map((r) => ({
            task_id: r.task_id,
            indexed_at: r.indexed_at,
            vector_size: r.vector_size,
            crossRef: r.crossRef,
            classification: Object.values(r.crossRef).some(Boolean)
              ? "pure-orphan (value present in another domain table)"
              : "orphan-but-data-bearing (value not in any other domain table; source recoverable from origin)",
          })),
          deleted: deletedIds,
          postCount: postCount[0].c,
          passed,
        },
        null,
        2
      )
    );

    if (!passed) process.exit(1);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
