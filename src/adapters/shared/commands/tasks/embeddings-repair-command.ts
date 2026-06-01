import { z } from "zod";
import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import type { CommandExecutionContext } from "../../command-registry";
import { type CommandParameterMap } from "../../command-registry";
import { CommonParameters } from "../../common-parameters";

const embeddingsRepairParams = {
  dryRun: {
    schema: z.boolean().default(false),
    description: "Only report what would be done without making changes",
    required: false,
  },
  workspace: CommonParameters.workspace,
  json: CommonParameters.json,
} satisfies CommandParameterMap;

interface EmbeddingsRepairParams extends BaseTaskParams {
  dryRun?: boolean;
}

export class TasksEmbeddingsRepairCommand extends BaseTaskCommand<EmbeddingsRepairParams> {
  readonly id = "tasks.embeddings-repair";
  readonly name = "embeddings-repair";
  readonly description = "Remove orphaned embeddings and report stale entries";
  readonly parameters = embeddingsRepairParams;

  async execute(params: EmbeddingsRepairParams, ctx: CommandExecutionContext) {
    if (!ctx.container?.has("persistence")) {
      return this.formatResult(
        { success: false, message: "Persistence not initialized (no container)" },
        params.json || ctx.format === "json"
      );
    }

    const provider = ctx.container.get(
      "persistence"
    ) as import("@minsky/domain/persistence/types").PersistenceProvider;
    if (!provider.capabilities.sql) {
      return this.formatResult(
        { success: false, message: "SQL not supported by current provider" },
        params.json || ctx.format === "json"
      );
    }

    const sql = await provider.getRawSqlConnection?.();
    if (!sql) {
      return this.formatResult(
        { success: false, message: "Could not obtain SQL connection" },
        params.json || ctx.format === "json"
      );
    }

    const pgSql = sql as import("postgres").Sql;
    const dryRun = params.dryRun ?? false;
    const isJson = params.json || ctx.format === "json";

    // Count orphaned embeddings
    const orphanRows = await pgSql.unsafe(
      "SELECT count(*)::int AS cnt FROM tasks_embeddings te" +
        " WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = te.task_id)"
    );
    const orphansFound = orphanRows[0]?.cnt ?? 0;

    let orphansDeleted = 0;

    if (!dryRun && orphansFound > 0) {
      const deleteResult = await pgSql.unsafe(
        "DELETE FROM tasks_embeddings" +
          " WHERE NOT EXISTS" +
          " (SELECT 1 FROM tasks t WHERE t.id = tasks_embeddings.task_id)"
      );
      orphansDeleted = deleteResult.count ?? orphansFound;
    }

    // Count entries with no content hash — report only.
    // The `tasks` table no longer stores a precomputed `content_hash` (it was dropped
    // in migration 0011_gifted_miss_america.sql), so the old
    // `te.content_hash IS DISTINCT FROM t.content_hash` join crashed with
    // "column t.content_hash does not exist" (mt#2220). Content-hash staleness is now
    // reconciled at index time: `indexTask` recomputes the hash from live task content
    // and skips/rewrites accordingly. The cheap SQL-level signal that remains is rows
    // that were never indexed with a hash at all (`content_hash IS NULL`); a full
    // staleness reconcile is `minsky tasks index-embeddings --reindex`.
    const staleRows = await pgSql.unsafe(
      "SELECT count(*)::int AS cnt FROM tasks_embeddings te WHERE te.content_hash IS NULL"
    );
    const staleCount = staleRows[0]?.cnt ?? 0;

    const result = {
      success: true,
      dryRun,
      orphansDeleted: dryRun ? 0 : orphansDeleted,
      orphansFound,
      staleCount,
    };

    if (!isJson) {
      const { log } = await import("@minsky/shared/logger");
      if (dryRun) {
        log.cli("[dry-run] No changes applied.");
        log.cli(`  Orphaned embeddings found: ${orphansFound}`);
        log.cli(`  Stale embeddings found:    ${staleCount}`);
      } else {
        log.cli(`Orphaned embeddings deleted: ${orphansDeleted}`);
        log.cli(`Stale embeddings found:      ${staleCount}`);
        if (staleCount > 0) {
          log.cli("  (Use 'minsky tasks index-embeddings --reindex' to refresh stale entries)");
        }
      }
    }

    return this.formatResult(result, isJson);
  }
}
