/**
 * Rules CRUD commands: get, create, update, generate
 */
import { getErrorMessage } from "@minsky/domain/errors/index";
import {
  CommandCategory,
  type CommandDefinition,
  type CommandParameterMap,
} from "../../command-registry";
import { type RuleFormat } from "@minsky/domain/rules";
import { log } from "@minsky/shared/logger";
import { resolveWorkspacePath as defaultResolveWorkspacePath } from "@minsky/domain/workspace";
import {
  getRule as defaultGetRule,
  createRule as defaultCreateRule,
  updateRule as defaultUpdateRule,
} from "@minsky/domain/rules/rules-command-operations";
import {
  rulesGetCommandParams,
  rulesCreateCommandParams,
  rulesUpdateCommandParams,
} from "./rules-parameters";

/**
 * Dependencies for rules CRUD commands (injectable for testing)
 */
export interface RulesCrudCommandsDeps {
  resolveWorkspacePath?: typeof defaultResolveWorkspacePath;
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

  // `rules.generate` was registered here until mt#4974 SC6. It rendered the
  // TypeScript rule templates, which are retired: rules now ship as markdown in
  // `packages/domain/src/rules/corpus` and `init` installs the base tier. There
  // is no replacement command — see `crud-operations.ts` for why nothing needed
  // one.

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
