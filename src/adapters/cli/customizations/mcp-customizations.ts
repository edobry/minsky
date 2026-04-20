/**
 * MCP Commands Customizations
 *
 * CLI customizations for MCP-related commands.
 *
 * The MCP category is hidden from the CLI auto-generation because the CLI
 * has an existing non-shared `mcp` commander command tree (src/commands/mcp/)
 * that includes `mcp.register` as a subcommand. Hiding the category here
 * prevents Commander.js from throwing on a duplicate `mcp` top-level command.
 */
import type { CategoryCommandOptions } from "../../shared/bridges/cli";
import { CommandCategory } from "../../shared/command-registry";

/**
 * Get customizations for MCP commands
 */
export function getMcpCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.MCP,
    options: {
      hidden: true,
    },
  };
}
