/**
 * Tools Commands Customizations
 *
 * CLI customizations for tools-related commands
 */
import type { CategoryCommandOptions } from "../../shared/bridges/cli";
import { CommandCategory } from "../../shared/command-registry";

/**
 * Get customizations for tools commands
 */
export function getToolsCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.TOOLS,
    options: {
      name: "tools",
      spec: "TOOLS commands",
      commandOptions: {
        // All tools commands use default customization
      },
    },
  };
}
