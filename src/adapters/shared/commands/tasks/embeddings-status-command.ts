import { BaseTaskCommand, type BaseTaskParams } from "./base-task-command";
import type { CommandExecutionContext, CommandParameterMap } from "../../command-registry";
import { CommonParameters } from "../../common-parameters";

const embeddingsStatusParams = {
  workspace: CommonParameters.workspace,
  json: CommonParameters.json,
} satisfies CommandParameterMap;

interface EmbeddingsStatusParams extends BaseTaskParams {}

export class TasksEmbeddingsStatusCommand extends BaseTaskCommand<EmbeddingsStatusParams> {
  readonly id = "tasks.embeddings-status";
  readonly name = "embeddings-status";
  readonly description = "Show embedding index coverage and health statistics";
  readonly parameters = embeddingsStatusParams;

  async execute(params: EmbeddingsStatusParams, ctx: CommandExecutionContext) {
    if (!ctx.container?.has("persistence")) {
      return this.formatResult(
        { success: false, message: "Persistence not initialized (no container)" },
        params.json || ctx.format === "json"
      );
    }

    const provider = ctx.container.get(
      "persistence"
    ) as import("../../../../domain/persistence/types").PersistenceProvider;
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

    const totalRows = await pgSql.unsafe("SELECT count(*)::int AS cnt FROM tasks");
    const indexedRows = await pgSql.unsafe("SELECT count(*)::int AS cnt FROM tasks_embeddings");
    const missingRows = await pgSql.unsafe(
      "SELECT count(*)::int AS cnt FROM tasks t" +
        " LEFT JOIN tasks_embeddings te ON t.id = te.task_id" +
        " WHERE te.task_id IS NULL"
    );
    const orphanedRows = await pgSql.unsafe(
      "SELECT count(*)::int AS cnt FROM tasks_embeddings te" +
        " WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = te.task_id)"
    );
    const lastRows = await pgSql.unsafe(
      "SELECT max(indexed_at) AS last_indexed FROM tasks_embeddings"
    );

    const total = totalRows[0]?.cnt ?? 0;
    const indexed = indexedRows[0]?.cnt ?? 0;
    const missing = missingRows[0]?.cnt ?? 0;
    const orphaned = orphanedRows[0]?.cnt ?? 0;
    const lastIndexed = lastRows[0]?.last_indexed ?? null;

    // Pull model/dimension from config
    const { getConfiguration } = await import("../../../../domain/configuration");
    const cfg = getConfiguration();
    const model = cfg.embeddings?.model || "text-embedding-3-small";
    const { getEmbeddingDimension } = await import("../../../../domain/ai/embedding-models");
    const dimension = getEmbeddingDimension(model, 1536);

    const result = {
      success: true,
      total,
      indexed,
      missing,
      orphaned,
      lastIndexed,
      model,
      dimension,
    };

    if (!(params.json || ctx.format === "json")) {
      const { log } = await import("../../../../utils/logger");
      log.cli(`Tasks total:    ${result.total}`);
      log.cli(`Indexed:        ${result.indexed}`);
      log.cli(`Missing:        ${result.missing}`);
      log.cli(`Orphaned:       ${result.orphaned}`);
      log.cli(`Last indexed:   ${result.lastIndexed ?? "never"}`);
      log.cli(`Model:          ${result.model}`);
      log.cli(`Dimension:      ${result.dimension}`);
    }

    return this.formatResult(result, params.json || ctx.format === "json");
  }
}
