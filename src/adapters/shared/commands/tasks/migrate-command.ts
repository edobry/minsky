/**
 * Task Migration / Import Command (md#429)
 *
 * Extends migrate to import markdown specs/metadata into DB by default.
 */

import { z } from "zod";
import type { CommandExecutionContext } from "../../command-registry";
import { BaseTaskCommand } from "./base-task-command";
import { log } from "../../../../utils/logger";
import { tasksMigrateParams } from "./task-parameters";
import { TasksImporterService } from "../../../../domain/tasks/tasks-importer-service";

const migrateParamsSchema = z.object({
  execute: z.boolean().optional().default(false),
  limit: z.number().int().positive().optional(),
  filterStatus: z.string().optional(),
  quiet: z.boolean().optional().default(false),
  json: z.boolean().optional().default(false),
});

export type MigrateParams = z.infer<typeof migrateParamsSchema>;

export class MigrateTasksCommand extends BaseTaskCommand<MigrateParams> {
  readonly id = "tasks.migrate";
  readonly name = "migrate";
  readonly description = "Import markdown task specs/metadata into DB (dry-run by default)";
  readonly parameters = tasksMigrateParams;

  async execute(params: MigrateParams, context: CommandExecutionContext): Promise<any> {
    const p = migrateParamsSchema.parse(params);
    const dryRun = !p.execute;

    if (!p.quiet) {
      log.cli(
        dryRun ? "🔍 DRY RUN: Previewing markdown → DB import..." : "🚀 Importing markdown → DB..."
      );
      if (p.filterStatus) log.cli(`📋 Filter status: ${p.filterStatus}`);
      if (typeof p.limit === "number") log.cli(`🔢 Limit: ${p.limit}`);
    }

    const importer = new TasksImporterService(context.workspacePath || process.cwd());
    const result = await importer.importMarkdownToDb({
      dryRun,
      limit: p.limit,
      filterStatus: p.filterStatus,
    });

    if (p.json || context.format === "json") {
      return { success: true, ...result };
    }

    this.display(result, dryRun);
    return {
      success: true,
      summary: {
        total: result.total,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors,
      },
    };
  }

  private display(result: any, dryRun: boolean): void {
    log.cli("\n📊 RESULTS:");
    log.cli(`📝 Total: ${result.total}`);
    if (result.inserted) log.cli(`➕ Inserted: ${result.inserted}`);
    if (result.updated) log.cli(`♻️  Updated: ${result.updated}`);
    if (result.skipped) log.cli(`⏭️  Skipped: ${result.skipped}`);
    if (result.errors) log.cli(`❌ Errors: ${result.errors}`);

    if (dryRun) log.cli("\n💡 Run with --execute to apply changes.");
  }
}

export function createMigrateTasksCommand(): MigrateTasksCommand {
  return new MigrateTasksCommand();
}
