/**
 * Git Command Customizations
 * @migrated Extracted from cli-command-factory.ts for focused responsibility
 */
import { CommandCategory } from "../../shared/command-registry";
import type { CategoryCommandOptions } from "../../shared/bridges/cli-bridge";

/**
 * Get git command customizations configuration
 * @returns Git category customization options
 */
export function getGitCustomizations(): { category: CommandCategory; options: CategoryCommandOptions } {
  return {
    category: CommandCategory.GIT,
    options: {
      commandOptions: {
        "git.commit": {
          parameters: {
            message: {
              alias: "m",
            },
          },
        },
      },
    },
  };
} 
