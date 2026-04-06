/**
 * Rules CRUD commands: get, create, update, generate
 */
import { getErrorMessage } from "../../../../errors/index";
import {
  CommandCategory,
  type CommandDefinition,
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../command-registry";
import { type RuleFormat } from "../../../../domain/rules";
import { log } from "../../../../utils/logger";
import { resolveWorkspacePath } from "../../../../domain/workspace";
import {
  getRule,
  generateRules,
  createRule,
  updateRule,
} from "../../../../domain/rules/rules-command-operations";
import {
  rulesGetCommandParams,
  rulesGenerateCommandParams,
  rulesCreateCommandParams,
  rulesUpdateCommandParams,
  type RulesGetParams,
  type RulesGenerateParams,
  type RulesCreateParams,
  type RulesUpdateParams,
} from "./rules-parameters";

export function registerCrudCommands(targetRegistry: {
  registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => void;
}): void {
  targetRegistry.registerCommand({
    id: "rules.get",
    category: CommandCategory.RULES,
    name: "get",
    description: "Get a specific rule by ID",
    parameters: rulesGetCommandParams,
    execute: async (params) => {
      log.debug("Executing rules.get command", { params });
      try {
        const workspacePath = await resolveWorkspacePath({});
        return await getRule({
          workspacePath,
          id: params.id,
          format: params.format as RuleFormat | undefined,
          debug: params.debug,
        });
      } catch (error) {
        log.error("Failed to get rule", { error: getErrorMessage(error), id: params.id });
        throw error;
      }
    },
  });

  targetRegistry.registerCommand({
    id: "rules.generate",
    category: CommandCategory.RULES,
    name: "generate",
    description: "Generate new rules from templates",
    parameters: rulesGenerateCommandParams,
    execute: async (params) => {
      log.debug("Executing rules.generate command", { params });
      try {
        const workspacePath = await resolveWorkspacePath({});
        return await generateRules({
          workspacePath,
          interface: params.interface,
          rules: params.rules,
          outputDir: params.outputDir,
          dryRun: params.dryRun,
          overwrite: params.overwrite,
          format: params.format as RuleFormat | undefined,
          preferMcp: params.preferMcp,
          mcpTransport: params.mcpTransport,
        });
      } catch (error) {
        log.error("Failed to generate rules", {
          error: getErrorMessage(error),
          interface: params.interface,
          selectedRules: params.rules,
          dryRun: params.dryRun,
          overwrite: params.overwrite,
        });
        throw error;
      }
    },
  });

  targetRegistry.registerCommand({
    id: "rules.create",
    category: CommandCategory.RULES,
    name: "create",
    description: "Create a new rule",
    parameters: rulesCreateCommandParams,
    execute: async (params) => {
      log.debug("Executing rules.create command", { params });
      try {
        const workspacePath = await resolveWorkspacePath({});
        return await createRule({
          workspacePath,
          id: params.id,
          content: params.content,
          description: params.description,
          name: params.name,
          globs: params.globs,
          tags: params.tags,
          format: params.format as RuleFormat | undefined,
          overwrite: params.overwrite,
        });
      } catch (error) {
        log.error("Failed to create rule", { error: getErrorMessage(error), id: params.id });
        throw error;
      }
    },
  });

  targetRegistry.registerCommand({
    id: "rules.update",
    category: CommandCategory.RULES,
    name: "update",
    description: "Update an existing rule",
    parameters: rulesUpdateCommandParams,
    execute: async (params) => {
      log.debug("Executing rules.update command", { params });
      try {
        const workspacePath = await resolveWorkspacePath({});
        return await updateRule({
          workspacePath,
          id: params.id,
          content: params.content,
          description: params.description,
          name: params.name,
          globs: params.globs,
          tags: params.tags,
          format: params.format as RuleFormat | undefined,
          debug: params.debug,
        });
      } catch (error) {
        log.error("Failed to update rule", { error: getErrorMessage(error), id: params.id });
        throw error;
      }
    },
  });
}
