/**
 * Session Repair Command Implementation
 */
import { BaseSessionCommand, type BaseSessionCommandParams } from "./base-session-command";
import { sessionRepairCommandParams } from "./session-parameters";
import {
  sessionRepair,
  SessionRepairParameters,
} from "../../../../domain/session/commands/repair-command";
import { type CommandExecutionContext } from "../../command-registry";
import { log } from "../../../../utils/logger";
import { toJsonRecord } from "../../../../utils/type-utils";
import { createSessionProvider } from "../../../../domain/session/session-db-adapter";
import { createGitService } from "../../../../domain/git";

/**
 * Parameters for session repair command
 */
interface SessionRepairParams extends BaseSessionCommandParams {
  dryRun?: boolean;
  auto?: boolean;
  interactive?: boolean;
  prState?: boolean;
  backendSync?: boolean;
  force?: boolean;
  debug?: boolean;
}

export class SessionRepairCommand extends BaseSessionCommand<
  SessionRepairParams,
  Record<string, unknown>
> {
  getCommandId(): string {
    return "session.repair";
  }

  getCommandName(): string {
    return "repair";
  }

  getCommandDescription(): string {
    return "Repair session state issues (PR state, backend sync, etc.)";
  }

  getParameterSchema(): Record<string, unknown> {
    return sessionRepairCommandParams;
  }

  async executeCommand(
    params: SessionRepairParams,
    context: CommandExecutionContext
  ): Promise<Record<string, unknown>> {
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

      const sessionDB = await createSessionProvider();
      const gitService = createGitService();
      const result = await sessionRepair(repairParams, { sessionDB, gitService });

      if (params.json) {
        return toJsonRecord(result);
      }

      // CLI output
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
