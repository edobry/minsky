// @ts-nocheck -- intentionally-bad lint fixture: the class-generic case violates
// BaseTaskCommand's CommandParameterMap constraint BY DESIGN (that is the bug
// shape the rule flags). eslint-rules/ is outside tsconfig include today; the
// pragma keeps this inert if that ever changes.
/**
 * Invalid fixture for custom/no-hand-rolled-command-params (mt#2779).
 * Every shape here re-opens the mt#2742 Detector-B hole and must be flagged.
 * Expected violations, in order:
 *   1. handRolledInterface       — `interface FixtureBadParams`
 *   2. handRolledAliasLiteral    — `type FixtureAliasParams = { ... }`
 *   3. handRolledAnnotation      — execute annotated with the interface
 *   4. handRolledAnnotation      — execute annotated with an inline literal
 *   5. untiedClassGeneric        — `extends BaseTaskCommand<FixtureBadParams>`
 *   6. handRolledAnnotation      — class execute annotated with the interface
 *   7. paramsCast                — `params as FixtureBadParams`
 */
import {
  CommandCategory,
  type CommandExecutionContext,
} from "../../../src/adapters/shared/command-registry";
import { BaseTaskCommand } from "../../../src/adapters/shared/commands/tasks/base-task-command";
import { fixtureParams } from "./valid";

// (1) Hand-rolled params interface.
interface FixtureBadParams {
  taskId: string;
  ghost?: string; // undeclared in any map — reads compile but are always undefined
}

// (2) Hand-rolled literal alias.
export type FixtureAliasParams = {
  taskId: string;
};

// (3) Execute annotated with the hand-rolled interface.
export const badAnnotatedCommand = {
  id: "fixture.bad-annotated",
  category: CommandCategory.TASKS,
  name: "bad-annotated",
  description: "fixture",
  parameters: fixtureParams,
  execute: async (params: FixtureBadParams) => params.ghost,
};

// (4) Execute annotated with an inline object literal type.
export const badInlineCommand = {
  id: "fixture.bad-inline",
  category: CommandCategory.TASKS,
  name: "bad-inline",
  description: "fixture",
  parameters: fixtureParams,
  execute: async (params: { taskId?: string; ghost?: string }) => params.ghost,
};

// (5) Class generic not tied to the map + (6) execute annotated hand-rolled.
export class FixtureBadClassCommand extends BaseTaskCommand<FixtureBadParams> {
  readonly id = "fixture.bad-class";
  readonly name = "bad-class";
  readonly description = "fixture";
  readonly parameters = fixtureParams;

  async execute(params: FixtureBadParams, _ctx: CommandExecutionContext) {
    return { ghost: params.ghost };
  }
}

// (7) Cast to a *Params type.
export function castThrough(params: unknown) {
  return (params as FixtureBadParams).ghost;
}
