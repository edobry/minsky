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
import { resolveWorkspacePath as defaultResolveWorkspacePath } from "../../../../domain/workspace";
import {
  getRule as defaultGetRule,
  generateRules as defaultGenerateRules,
  createRule as defaultCreateRule,
  updateRule as defaultUpdateRule,
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

/**
 * Dependencies for rules CRUD commands (injectable for testing)
 */
export interface RulesCrudCommandsDeps {
  resolveWorkspacePath?: typeof defaultResolveWorkspacePath;
  generateRules?: typeof defaultGenerateRules;
  getRule?: typeof defaultGetRule;
  createRule?: typeof defaultCreateRule;
  updateRule?: typeof defaultUpdateRule;
}

export function registerCrudCommands(
  targetRegistry: {
    registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => void;
  },
  deps?: RulesCrudCommandsDeps
): void {
  const resolveWorkspacePath = deps?.resolveWorkspacePath ?? defaultResolveWorkspacePath;
  const generateRules = deps?.generateRules ?? defaultGenerateRules;
  const getRule = deps?.getRule ?? defaultGetRule;
  const createRule = deps?.createRule ?? defaultCreateRule;
  const updateRule = deps?.updateRule ?? defaultUpdateRule;
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
