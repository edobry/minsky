import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { sessionOutdated, formatOutdatedSessionsResult } from "../outdated-command";
import { log } from "../../../../utils/logger";

/**
 * Parameters for the session outdated command
 * TASK 360: CLI parameter definitions for session outdated command
 */
export const sessionOutdatedCommandParams: CommandParameterMap = {
  severity: {
    schema: z.enum(["current", "stale", "very-stale", "ancient"]),
    description: "Filter by severity level",
    required: false,
  },
  sort: {
    schema: z.enum(["commits", "days"]),
    description: "Sort by commits behind or days old",
    required: false,
    defaultValue: "commits",
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  verbose: {
    schema: z.boolean(),
    description: "Show verbose output including errors",
    required: false,
    defaultValue: false,
  },
};

/**
 * Execute the session outdated command
 * TASK 360: Implementation of session outdated CLI command execution
 */
export async function executeSessionOutdatedCommand(
  parameters: {
    [K in keyof typeof sessionOutdatedCommandParams]: z.infer<
      (typeof sessionOutdatedCommandParams)[K]["schema"]
    >;
  },
  context: CommandExecutionContext
): Promise<any> {
  const { severity, sort, json, verbose } = parameters;

  const result = await sessionOutdated({
    severity,
    sort,
    json,
    verbose,
  });

  // Handle JSON output
  if (json) {
    log.cli(JSON.stringify(result, null, 2));
    return result;
  }

  // Format for human-readable output
  formatOutdatedSessionsResult(result);

  if (context.debug) {
    log.debug("Session outdated command executed successfully", { result });
  }

  return result;
}
