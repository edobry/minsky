/**
 * INIT Commands Customizations
 *
 * CLI customizations for INIT-related commands (init, setup).
 *
 * The INIT category is hidden from the CLI auto-generation because the CLI
 * has non-shared commander commands (src/commands/init/, src/commands/setup/)
 * that register `init` and `setup` directly as top-level commands. Hiding
 * the category here prevents Commander.js from throwing on duplicate top-level
 * command names.
 */
import type { CategoryCommandOptions } from "../../shared/bridges/cli";
import { CommandCategory } from "../../shared/command-registry";

/**
 * Get customizations for INIT commands
 */
export function getInitCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.INIT,
    options: {
      hidden: true,
    },
  };
}
