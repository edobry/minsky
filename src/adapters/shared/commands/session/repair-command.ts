/**
 * Session Repair Command
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { type LazySessionDeps, withErrorLogging } from "./types";
import { sessionRepairCommandParams } from "./session-parameters";
import {
  sessionRepair,
  type SessionRepairParameters,
} from "../../../../domain/session/commands/repair-command";
import { log } from "../../../../utils/logger";
import { toJsonRecord } from "../../../../utils/type-utils";
import { getErrorMessage } from "../../../../errors/index";

export function createSessionRepairCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.repair",
    category: CommandCategory.SESSION,
    name: "repair",
    description: "Repair session state issues (PR state, backend sync, etc.)",
    parameters: sessionRepairCommandParams,
    execute: withErrorLogging("session.repair", async (params: Record<string, unknown>) => {
      try {
        const deps = await getDeps();
        const repairParams: SessionRepairParameters = {
          sessionId: params.sessionId as string | undefined,
          task: params.task as string | undefined,
          repo: params.repo as string | undefined,
          dryRun: params.dryRun as boolean | undefined,
          auto: params.auto as boolean | undefined,
          interactive: params.interactive as boolean | undefined,
          prState: params.prState as boolean | undefined,
          backendSync: params.backendSync as boolean | undefined,
          force: params.force as boolean | undefined,
          debug: params.debug as boolean | undefined,
        };

        const result = await sessionRepair(repairParams, {
          sessionDB: deps.sessionProvider,
          gitService: deps.gitService,
        });

        if (params.json) {
          return toJsonRecord(result);
        }

        if (result.success) {
          log.cli(`✅ Session repair completed for '${result.sessionId}'`);

          if (result.issuesFound.length === 0) {
            log.cli("No issues found - session is healthy");
          } else {
            log.cli(`📊 Summary:`);
            log.cli(`  • Issues found: ${result.issuesFound.length}`);
            log.cli(`  • Repairs applied: ${result.repairsApplied.length}`);
            log.cli(`  • Repairs skipped: ${result.repairsSkipped.length}`);

            if (result.repairsApplied.length > 0) {
              log.cli("\n🔧 Repairs applied:");
              result.repairsApplied.forEach((repair) => {
                log.cli(`  ✅ ${repair.description}`);
              });
            }

            if (result.repairsSkipped.length > 0) {
              log.cli("\n⏭️  Repairs skipped:");
              result.repairsSkipped.forEach((repair) => {
                log.cli(`  ⚠️  ${repair.description}`);
              });
            }
          }
        } else {
          log.cli(`❌ Session repair failed for '${result.sessionId}'`);
        }

        return { ...result, success: true };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        log.error("Session repair failed", { error: errorMessage });

        if (params.json) {
          return { success: false, error: errorMessage };
        }

        throw error;
      }
    }),
  };
}
