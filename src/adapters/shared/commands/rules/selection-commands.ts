/**
 * Rules selection commands: enable, disable, config, presets
 */
import { z } from "zod";
import { CommandCategory } from "../../command-registry";
import { resolveWorkspacePath } from "../../../../domain/workspace";
import {
  enableRule,
  disableRule,
  getRulesConfig,
  getRulesPresets,
} from "../../../../domain/rules/rules-command-operations";

export function registerSelectionCommands(targetRegistry: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- command definitions use specific typed execute handlers incompatible with generic SharedCommand
  registerCommand: (cmd: any) => void;
}): void {
  targetRegistry.registerCommand({
    id: "rules.enable",
    category: CommandCategory.RULES,
    name: "enable",
    description: "Add a rule ID to the enabled list in the project config",
    parameters: {
      ruleId: { schema: z.string(), description: "The rule ID to enable", required: true },
    },
    execute: async (params: { ruleId: string }) => {
      const workspacePath = await resolveWorkspacePath({});
      const result = await enableRule(workspacePath, params.ruleId);
      return { success: true, ruleId: params.ruleId, ...result };
    },
  });

  targetRegistry.registerCommand({
    id: "rules.disable",
    category: CommandCategory.RULES,
    name: "disable",
    description: "Add a rule ID to the disabled list in the project config",
    parameters: {
      ruleId: { schema: z.string(), description: "The rule ID to disable", required: true },
    },
    execute: async (params: { ruleId: string }) => {
      const workspacePath = await resolveWorkspacePath({});
      const result = await disableRule(workspacePath, params.ruleId);
      return { success: true, ruleId: params.ruleId, ...result };
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
