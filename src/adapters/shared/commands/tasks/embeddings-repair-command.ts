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
    const { PersistenceService } = await import("../../../../domain/persistence/service");
    if (!PersistenceService.isInitialized()) {
      return this.formatResult(
        { success: false, message: "Persistence not initialized" },
        params.json || ctx.format === "json"
      );
    }

    const provider = PersistenceService.getProvider();
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

    // Count stale entries (content_hash mismatch) — report only
    // Stale entries have a content_hash that no longer matches the task's
    // current content. Reindexing is done via `index-embeddings --reindex`.
    const staleRows = await pgSql.unsafe(
      "SELECT count(*)::int AS cnt FROM tasks_embeddings te" +
        " JOIN tasks t ON t.id = te.task_id" +
        " WHERE te.content_hash IS DISTINCT FROM t.content_hash"
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
      const { log } = await import("../../../../utils/logger");
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
