/**
 * COMPILE Commands Customizations
 *
 * The COMPILE category is hidden from the CLI auto-generation because
 * `compile` is registered as a direct top-level command in src/cli.ts
 * (via createCompileCommand). Hiding the category here prevents Commander.js
 * from generating a duplicate `compile compile` nested command.
 */

import type { CategoryCommandOptions } from "../../shared/bridges/cli";
import { CommandCategory } from "../../shared/command-registry";

export function getCompileCustomizations(): {
  category: CommandCategory;
  options: CategoryCommandOptions;
} {
  return {
    category: CommandCategory.COMPILE,
    options: {
      hidden: true,
    },
  };
}
