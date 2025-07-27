// Config commands customization
cliFactory.customizeCategory(CommandCategory.CONFIG, {
  commandOptions: {
    "config.list": {
      outputFormatter: (result: any) => {
        // Check if JSON output was requested
        if (result.json) {
          // For JSON output, return flattened key-value pairs (matching normal output)
          const flattened = flattenObjectToKeyValue(result.resolved);
          log.cli(JSON.stringify(flattened, null, 2));
          return;
        }

        if (result.success && result.resolved) {
          let output = "";

          // Show sources if explicitly requested
          if (result.showSources && result.sources) {
            output += formatConfigurationSources(result.resolved, result.sources);
          } else {
            // For config list, show flattened key=value pairs
            output += formatFlattenedConfiguration(result.resolved);
          }

          log.cli(output as unknown);
        } else if (result.error) {
          log.cli(`Failed to load configuration: ${result.error}`);
        } else {
          log.cli(JSON.stringify(result as unknown, null, 2));
        }
      },
    },
    "config.show": {
      outputFormatter: (result: any) => {
        // Check if JSON output was requested
        if (result.json) {
          log.cli(JSON.stringify(result as unknown, null, 2));
          return;
        }

        if (result.success && result.configuration) {
          let output = "";

          // Show sources if explicitly requested
          if (result.showSources && result.sources) {
            output += formatConfigurationSources(result.configuration, result.sources);
          } else {
            // Default human-friendly structured view
            output += formatResolvedConfiguration(result.configuration);
          }

          log.cli(output as unknown);
        } else if (result.error) {
          log.cli(`Failed to load configuration: ${result.error}`);
        } else {
          log.cli(JSON.stringify(result as unknown, null, 2));
        }
      },
    },
  },
});

// Rules commands customization
cliFactory.customizeCategory(CommandCategory.RULES, {
  commandOptions: {
    "rules.generate": {
      parameters: {
        interface: {
          description: "Interface preference (cli, mcp, or hybrid)",
        },
        rules: {
          description: "Comma-separated list of specific rule templates to generate",
        },
        outputDir: {
          description: "Output directory for generated rules",
        },
        dryRun: {
          alias: "n",
          description: "Show what would be generated without creating files",
        },
        overwrite: {
          description: "Overwrite existing rule files",
        },
        format: {
          description: "Rule format (cursor or openai)",
        },
        preferMcp: {
          description: "In hybrid mode, prefer MCP commands over CLI",
        },
        mcpTransport: {
          description: "MCP transport method (stdio or http)",
        },
      },
    },
    "rules.list": {
      parameters: {
        format: {
          description: "Filter by rule format (cursor or generic)",
        },
        tag: {
          description: "Filter by tag",
        },
      },
    },
    "rules.get": {
      useFirstRequiredParamAsArgument: true,
      parameters: {
        id: {
          asArgument: true,
          description: "Rule ID",
        },
        format: {
          description: "Preferred rule format (cursor or generic)",
        },
      },
    },
    "rules.create": {
      useFirstRequiredParamAsArgument: true,
      parameters: {
        id: {
          asArgument: true,
          description: "ID of the rule to create",
        },
        content: {
          description: "Rule content (can be a file path starting with @)",
        },
        description: {
          description: "Description of the rule",
        },
        name: {
          description: "Display name for the rule",
        },
        globs: {
          description: "Comma-separated list of glob patterns",
        },
        tags: {
          description: "Comma-separated list of tags",
        },
        format: {
          description: "Rule format (cursor or generic)",
        },
        overwrite: {
          description: "Overwrite existing rule if it exists",
        },
      },
    },
    "rules.update": {
      useFirstRequiredParamAsArgument: true,
      parameters: {
        id: {
          asArgument: true,
          description: "ID of the rule to update",
        },
        content: {
          description: "Updated rule content (can be a file path starting with @)",
        },
        description: {
          description: "Updated description of the rule",
        },
        name: {
          description: "Updated display name for the rule",
        },
        globs: {
          description: "Updated comma-separated list of glob patterns",
        },
        tags: {
          description: "Updated comma-separated list of tags",
        },
        format: {
          description: "Updated rule format (cursor or generic)",
        },
      },
    },
    "rules.search": {
      parameters: {
        query: {
          description: "Search query term",
        },
        tag: {
          description: "Filter by tag",
        },
        format: {
          description: "Filter by rule format (cursor or generic)",
        },
      },
    },
  },
});