/**
 * Rules selection commands: enable, disable, config, presets
 */
import { z } from "zod";
import {
  CommandCategory,
  type CommandDefinition,
  type CommandParameterMap,
} from "../../command-registry";
import { resolveWorkspacePath } from "@minsky/domain/workspace";
import { ValidationError } from "@minsky/domain/errors/index";
import {
  enableRule,
  disableRule,
  getRulesConfig,
  getRulesPresets,
} from "@minsky/domain/rules/rules-command-operations";

/**
 * Resolve the rule id from the canonical `id` param (rules_* family convention —
 * rules_get/create/update use `id`) or the legacy `ruleId` alias (mt#2741). Throws
 * when neither is supplied so a convention-following caller gets a clear error
 * instead of a silently-dropped param.
 */
export function resolveRuleId(
  params: { id?: string; ruleId?: string },
  commandName: string
): string {
  const id = params.id ?? params.ruleId;
  if (!id) {
    throw new ValidationError(
      `${commandName} requires 'id' ('ruleId' is accepted as a legacy alias)`
    );
  }
  return id;
}

export function registerSelectionCommands(targetRegistry: {
  registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => void;
}): void {
  targetRegistry.registerCommand({
    id: "rules.enable",
    category: CommandCategory.RULES,
    name: "enable",
    description: "Add a rule ID to the enabled list in the project config",
    parameters: {
      id: {
        schema: z.string().optional(),
        description: "The rule ID to enable",
        required: false,
      },
      ruleId: {
        schema: z.string().optional(),
        description: "Legacy alias for id (also accepted; prefer id)",
        required: false,
      },
    },
    execute: async (params: { id?: string; ruleId?: string }) => {
      const ruleId = resolveRuleId(params, "rules.enable");
      const workspacePath = await resolveWorkspacePath({});
      const result = await enableRule(workspacePath, ruleId);
      return { success: true, ruleId, ...result };
    },
  });

  targetRegistry.registerCommand({
    id: "rules.disable",
    category: CommandCategory.RULES,
    name: "disable",
    description: "Add a rule ID to the disabled list in the project config",
    parameters: {
      id: {
        schema: z.string().optional(),
        description: "The rule ID to disable",
        required: false,
      },
      ruleId: {
        schema: z.string().optional(),
        description: "Legacy alias for id (also accepted; prefer id)",
        required: false,
      },
    },
    execute: async (params: { id?: string; ruleId?: string }) => {
      const ruleId = resolveRuleId(params, "rules.disable");
      const workspacePath = await resolveWorkspacePath({});
      const result = await disableRule(workspacePath, ruleId);
      return { success: true, ruleId, ...result };
    },
  });

  targetRegistry.registerCommand({
    id: "rules.config",
    category: CommandCategory.RULES,
    name: "config",
    description: "Show current rule selection state (presets, enabled, disabled)",
    parameters: {},
    execute: async () => {
      const workspacePath = await resolveWorkspacePath({});
      return await getRulesConfig(workspacePath);
    },
  });

  targetRegistry.registerCommand({
    id: "rules.presets",
    category: CommandCategory.RULES,
    name: "presets",
    description: "List available rule presets with their rule counts",
    parameters: {},
    execute: async () => getRulesPresets(),
  });
}
