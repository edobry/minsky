    .action(async (id: string, options: {
      format?: string;
      description?: string;
      name?: string;
      globs?: string;
      alwaysApply?: string;
      tags?: string;
      content?: string;
    }) => {
      try {
        // Resolve workspace path (await the Promise)
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert CLI options to domain parameters
        const format = options.format as RuleFormat | undefined;
        
        // Build update options objects
        const updateOptions: {
          content?: string;
          meta?: Record<string, any>;
        } = {};
        
        if (options.content) {
          updateOptions.content = options.content;
        }
        
        // Build meta object only if there are metadata changes
        if (options.description || options.name || options.globs || 
            options.alwaysApply !== undefined || options.tags) {
          updateOptions.meta = {};
          
          if (options.description) updateOptions.meta.description = options.description;
          if (options.name) updateOptions.meta.name = options.name;
          
          if (options.globs) {
            updateOptions.meta.globs = options.globs.split(",").map(g => g.trim());
          }
          
          if (options.alwaysApply !== undefined) {
            updateOptions.meta.alwaysApply = options.alwaysApply.toLowerCase() === "true";
          }
          
          if (options.tags) {
            updateOptions.meta.tags = options.tags.split(",").map(t => t.trim());
          }
        }
        
        // Call domain function
        const rule = await ruleService.updateRule(id, updateOptions, {
          format,
        });

        console.log(`Rule '${rule.id}' updated successfully`);
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
        }
        process.exit(1);
      }
    });
}

/**
 * Creates the rules search command
 */
export function createSearchCommand(): Command {
  return new Command("search")
    .description("Search for rules")
    .option("--format <format>", "Filter by rule format (cursor or generic)")
    .option("--tag <tag>", "Filter by tag")
    .option("--query <query>", "Search query")
    .option("--json", "Output as JSON")
    .action(async (options: {
      format?: string;
      tag?: string;
      query?: string;
      json?: boolean;
    }) => {
      try {
        // Resolve workspace path (await the Promise)
        const workspacePath = await resolveWorkspacePath({});
        const ruleService = new RuleService(workspacePath);

        // Convert CLI options to domain parameters
        const format = options.format as RuleFormat | undefined;
        
        // Call domain function
        const rules = await ruleService.searchRules({
          format,
          tag: options.tag,
          query: options.query,
        });

        // Format and display output
        if (options.json) {
          console.log(JSON.stringify(rules, null, 2));
        } else {
          if (rules.length === 0) {
            console.log("No matching rules found");
            return;
          }

          console.log(`Found ${rules.length} matching rules:`);
          rules.forEach((rule) => {
            console.log(`- ${rule.id} (${rule.format}): ${rule.description || "No description"}`);
          });
        }
      } catch (error) {
        if (error instanceof MinskyError) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
        }
        process.exit(1);
      }
    });
}

/**
 * Creates the main rules command with all subcommands
 */
export function createRulesCommand(): Command {
  const rulesCommand = new Command("rules").description("Rules management operations");

  rulesCommand.addCommand(createListCommand());
  rulesCommand.addCommand(createGetCommand());
  rulesCommand.addCommand(createCreateCommand());
  rulesCommand.addCommand(createUpdateCommand());
  rulesCommand.addCommand(createSearchCommand());

  return rulesCommand;
} 
