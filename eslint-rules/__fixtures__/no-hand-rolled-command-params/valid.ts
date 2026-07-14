/**
 * Valid fixture for custom/no-hand-rolled-command-params (mt#2779).
 * Every shape here derives handler param types from the params map.
 */
import { z } from "zod";
import {
  defineCommand,
  CommandCategory,
  type CommandParameterMap,
  type InferParams,
  type CommandExecutionContext,
} from "../../../src/adapters/shared/command-registry";
import { BaseTaskCommand } from "../../../src/adapters/shared/commands/tasks/base-task-command";

export const fixtureParams = {
  taskId: { schema: z.string(), description: "task id", required: true },
  limit: { schema: z.number().optional(), description: "limit", required: false },
} satisfies CommandParameterMap;

// Derived alias — allowed.
export type FixtureParams = InferParams<typeof fixtureParams>;

// Non-*Params literal shape — out of the rule's namespace, allowed.
interface FixtureResultDetail {
  ok: boolean;
}

// Handler with NO annotation — contextual inference, the preferred form.
export const inferredCommand = defineCommand({
  id: "fixture.inferred",
  category: CommandCategory.TASKS,
  name: "inferred",
  description: "fixture",
  parameters: fixtureParams,
  execute: async (params) =>
    ({ ok: true, taskId: params.taskId }) satisfies FixtureResultDetail & {
      taskId: string;
    },
});

// Handler with an explicit InferParams annotation — allowed.
export const annotatedCommand = defineCommand({
  id: "fixture.annotated",
  category: CommandCategory.TASKS,
  name: "annotated",
  description: "fixture",
  parameters: fixtureParams,
  execute: async (params: InferParams<typeof fixtureParams>, _ctx: CommandExecutionContext) => ({
    taskId: params.taskId,
  }),
});

// Class command tied to its map via `typeof` generic + InferParams execute.
export class FixtureClassCommand extends BaseTaskCommand<typeof fixtureParams> {
  readonly id = "fixture.class";
  readonly name = "class";
  readonly description = "fixture";
  readonly parameters = fixtureParams;

  async execute(params: InferParams<typeof fixtureParams>, _ctx: CommandExecutionContext) {
    return { taskId: params.taskId };
  }
}
