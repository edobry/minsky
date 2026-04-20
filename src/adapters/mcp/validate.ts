/**
 * MCP adapter for validate commands (lint and typecheck)
 */
import type { CommandMapper } from "../../mcp/command-mapper";
import { registerToolsCommandsWithMcp } from "./shared-command-integration";

/**
 * Registers validate tools (lint, typecheck) with the MCP command mapper
 */
export function registerValidateTools(
  commandMapper: CommandMapper,
  container?: import("../../composition/types").AppContainerInterface
): void {
  registerToolsCommandsWithMcp(commandMapper, {
    container,
    commandOverrides: {
      "validate.lint": {
        description: "Run ESLint and return structured results",
      },
      "validate.typecheck": {
        description: "Run TypeScript type checker and return structured results",
      },
    },
  });
}
