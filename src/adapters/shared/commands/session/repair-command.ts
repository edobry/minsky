/**
 * Session Repair Command Implementation
 */
import { BaseSessionCommand } from "./base-session-command";
import { sessionRepairCommandParams } from "./session-parameters";
import {
  sessionRepair,
  SessionRepairParameters,
} from "../../../../domain/session/commands/repair-command";
import { CommandExecutionContext } from "../../command-types";
import { log } from "../../../../utils/logger";

export class SessionRepairCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.repair";
  }

  getCommandName(): string {
    return "repair";
  }

  getCommandDescription(): string {
    return "Repair session state issues (PR state, backend sync, etc.)";
  }

  getParameterSchema(): Record<string, any> {
    return sessionRepairCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    try {
      const repairParams: SessionRepairParameters = {
        name: params.name,
        task: params.task,
        repo: params.repo,
        dryRun: params.dryRun,
        auto: params.auto,
        interactive: params.interactive,
        prState: params.prState,
        backendSync: params.backendSync,
        force: params.force,
        debug: params.debug,
      };

      const result = await sessionRepair(repairParams);

      if (params.json) {
        return result;
      }

      // CLI output
      if (result.success) {
        log.cli(`✅ Session repair completed for '${result.sessionName}'`);

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
        log.cli(`❌ Session repair failed for '${result.sessionName}'`);
      }

      return this.createSuccessResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Session repair failed", { error: errorMessage });

      if (params.json) {
        return this.createErrorResult(errorMessage);
      }

      throw error;
    }
  }
}

export function createSessionRepairCommand() {
  return new SessionRepairCommand();
}
