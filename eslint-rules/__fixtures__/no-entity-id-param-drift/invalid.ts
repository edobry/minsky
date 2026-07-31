/**
 * Invalid fixture for custom/no-entity-id-param-drift (mt#2780).
 * Fed to the RuleTester with a `src/adapters/shared/commands/tasks/...`
 * filename. Expected violations, in order:
 *   1. aliasWithoutCanonical — satisfies-map declares `task` without `taskId`
 *   2. aliasWithoutCanonical — inline `parameters:` map, same drift
 *   3. aliasWithoutCanonical — class `readonly parameters` map, same drift
 */
import { z } from "zod";
import type { CommandParameterMap } from "../../../src/adapters/shared/command-registry";

// (1) The mt#2741 Detector-A shape: alias alone in a tasks-family map.
export const driftedParams = {
  task: { schema: z.string(), description: "should be taskId (+ optional alias)", required: true },
  limit: { schema: z.number().optional(), description: "limit", required: false },
} satisfies CommandParameterMap;

// (2) Same drift on an inline registration-object map.
export const driftedRegistration = {
  id: "tasks.fixture-drift",
  parameters: {
    task: { schema: z.string(), description: "drifted", required: true },
  },
  execute: async () => ({}),
};

// (3) Same drift on a class field map.
export class DriftedCommand {
  readonly id = "tasks.fixture-drift-class";
  readonly parameters = {
    task: { schema: z.string(), description: "drifted", required: true },
  };
}
