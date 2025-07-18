#!/usr/bin/env bun

/**
 * Convert CLI command references to MCP tool references in rule files
 * This script provides immediate MCP-only rules while preparing for the full template system
 */

import { promises as fs } from "fs";
import { join } from "path";
import { glob } from "glob";

// Context-aware CLI to MCP tool replacements that preserve grammatical sense
const CLI_TO_MCP_REPLACEMENTS = [
  // === TASK MANAGEMENT ===

  // "Run" patterns
  {
    pattern: /Run `minsky tasks list[^`]*`/g,
    replacement: "Use MCP tool `tasks.list`"
  },
  {
    pattern: /run `minsky tasks list[^`]*`/g,
    replacement: "use MCP tool `tasks.list`"
  },
  {
    pattern: /Run `minsky tasks get[^`]*`/g,
    replacement: "Use MCP tool `tasks.get`"
  },
  {
    pattern: /run `minsky tasks get[^`]*`/g,
    replacement: "use MCP tool `tasks.get`"
  },
  {
    pattern: /Run `minsky tasks status get[^`]*`/g,
    replacement: "Use MCP tool `tasks.status.get`"
  },
  {
    pattern: /run `minsky tasks status get[^`]*`/g,
    replacement: "use MCP tool `tasks.status.get`"
  },
  {
    pattern: /Run `minsky tasks spec[^`]*`/g,
    replacement: "Use MCP tool `tasks.spec`"
  },
  {
    pattern: /run `minsky tasks spec[^`]*`/g,
    replacement: "use MCP tool `tasks.spec`"
  },

  // "use:" patterns
  {
    pattern: /use: `minsky tasks list[^`]*`/g,
    replacement: "use MCP tool `tasks.list`"
  },
  {
    pattern: /use `minsky tasks list[^`]*`/g,
    replacement: "use MCP tool `tasks.list`"
  },

  // Code block replacements - single line commands
  {
    pattern: /^(\s*)minsky tasks list(\s+--json)?(\s*)$/gm,
    replacement: "$1# Use MCP tool: tasks.list$3"
  },
  {
    pattern: /^(\s*)minsky tasks get\s+([#<"']?[\w-]+[>"']?)(\s+--json)?(\s*)$/gm,
    replacement: "$1# Use MCP tool: tasks.get with taskId: $2$4"
  },
  {
    pattern: /^(\s*)minsky tasks status get\s+([#<"']?[\w-]+[>"']?)(\s*)$/gm,
    replacement: "$1# Use MCP tool: tasks.status.get with taskId: $2$3"
  },
  {
    pattern: /^(\s*)minsky tasks status set\s+([#<"']?[\w-]+[>"']?)\s+(\w+)(\s*)$/gm,
    replacement: "$1# Use MCP tool: tasks.status.set with taskId: $2, status: $3$4"
  },
  {
    pattern: /^(\s*)minsky tasks spec\s+([#<"']?[\w-]+[>"']?)(\s*)$/gm,
    replacement: "$1# Use MCP tool: tasks.spec with taskId: $2$3"
  },
  {
    pattern: /^(\s*)minsky tasks create\s+(.+)$/gm,
    replacement: "$1# Use MCP tool: tasks.create with $2"
  },

  // === SESSION MANAGEMENT ===

  // "Run" patterns for sessions
  {
    pattern: /Run `minsky session start[^`]*`/g,
    replacement: "Use MCP tool `session.start`"
  },
  {
    pattern: /run `minsky session start[^`]*`/g,
    replacement: "use MCP tool `session.start`"
  },
  {
    pattern: /Run `minsky session list[^`]*`/g,
    replacement: "Use MCP tool `session.list`"
  },
  {
    pattern: /run `minsky session list[^`]*`/g,
    replacement: "use MCP tool `session.list`"
  },

  // Code block replacements for sessions
  {
    pattern: /^(\s*)minsky session start\s+(.+)$/gm,
    replacement: "$1# Use MCP tool: session.start with $2"
  },
  {
    pattern: /^(\s*)minsky session list(\s*)$/gm,
    replacement: "$1# Use MCP tool: session.list$2"
  },
  {
    pattern: /^(\s*)minsky session pr(\s+.+)?$/gm,
    replacement: "$1# Use MCP tool: session.pr$2"
  },

  // === GIT OPERATIONS ===

  // "Run" patterns for git
  {
    pattern: /Run `minsky git commit[^`]*`/g,
    replacement: "Use MCP tool `git.commit`"
  },
  {
    pattern: /run `minsky git commit[^`]*`/g,
    replacement: "use MCP tool `git.commit`"
  },
  {
    pattern: /Run `minsky git push[^`]*`/g,
    replacement: "Use MCP tool `git.push`"
  },
  {
    pattern: /run `minsky git push[^`]*`/g,
    replacement: "use MCP tool `git.push`"
  },

  // Code block replacements for git
  {
    pattern: /^(\s*)minsky git commit\s+(.+)$/gm,
    replacement: "$1# Use MCP tool: git.commit with $2"
  },
  {
    pattern: /^(\s*)minsky git push(\s*)$/gm,
    replacement: "$1# Use MCP tool: git.push$2"
  },

  // === RULES MANAGEMENT ===

  // "Run" patterns for rules
  {
    pattern: /Run `minsky rules[^`]*`/g,
    replacement: "Use MCP tool `rules.list`"
  },
  {
    pattern: /run `minsky rules[^`]*`/g,
    replacement: "use MCP tool `rules.list`"
  },

  // Code block replacements for rules
  {
    pattern: /^(\s*)minsky rules list(\s*)$/gm,
    replacement: "$1# Use MCP tool: rules.list$2"
  },
  {
    pattern: /^(\s*)minsky rules get\s+(.+)$/gm,
    replacement: "$1# Use MCP tool: rules.get with id: $2"
  },

  // === GENERIC PATTERNS ===

  // Backtick inline references - convert to MCP tool mentions
  {
    pattern: /`minsky tasks list[^`]*`(?!\s*MCP tool)/g,
    replacement: "`tasks.list` MCP tool"
  },
  {
    pattern: /`minsky tasks get[^`]*`(?!\s*MCP tool)/g,
    replacement: "`tasks.get` MCP tool"
  },
  {
    pattern: /`minsky tasks status[^`]*`(?!\s*MCP tool)/g,
    replacement: "`tasks.status` MCP tool"
  },
  {
    pattern: /`minsky session[^`]*`(?!\s*MCP tool)/g,
    replacement: "`session` MCP tools"
  },
  {
    pattern: /`minsky git[^`]*`(?!\s*MCP tool)/g,
    replacement: "`git` MCP tools"
  },
  {
    pattern: /`minsky rules[^`]*`(?!\s*MCP tool)/g,
    replacement: "`rules` MCP tools"
  },

  // === COMMAND HELP REFERENCES ===

  // Help command references
  {
    pattern: /`minsky tasks --help`/g,
    replacement: "MCP tools documentation for tasks"
  },
  {
    pattern: /`minsky session --help`/g,
    replacement: "MCP tools documentation for session"
  },
  {
    pattern: /`minsky rules --help`/g,
    replacement: "MCP tools documentation for rules"
  },
  {
    pattern: /`minsky git --help`/g,
    replacement: "MCP tools documentation for git"
  }
];

interface ConversionOptions {
  dryRun?: boolean;
  verbose?: boolean;
  filePattern?: string;
}

async function convertRulesToMCP(options: ConversionOptions = {}) {
  const { dryRun = false, verbose = false, filePattern = ".cursor/rules/*.mdc" } = options;

  console.log(`🔄 ${dryRun ? "DRY RUN: " : ""}Converting CLI references to MCP tools in rule files...`);

  const ruleFiles = await glob(filePattern);
  let totalReplacements = 0;
  let processedFiles = 0;

  for (const filePath of ruleFiles) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      let modifiedContent = content;
      let fileReplacements = 0;

      // Apply all replacements
      for (const replacement of CLI_TO_MCP_REPLACEMENTS) {
        const matches = modifiedContent.match(replacement.pattern);
        if (matches) {
          modifiedContent = modifiedContent.replace(replacement.pattern, replacement.replacement);
          fileReplacements += matches.length;
        }
      }

      if (fileReplacements > 0) {
        processedFiles++;
        totalReplacements += fileReplacements;

        if (verbose) {
          console.log(`📝 ${filePath}: ${fileReplacements} replacements`);
        }

        if (!dryRun) {
          await fs.writeFile(filePath, modifiedContent, "utf-8");
        }
      }
    } catch (error) {
      console.error(`❌ Error processing ${filePath}:`, error);
    }
  }

  console.log("\n✅ Summary:");
  console.log(`   📂 Files scanned: ${ruleFiles.length}`);
  console.log(`   📝 Files with changes: ${processedFiles}`);
  console.log(`   🔄 Total replacements: ${totalReplacements}`);

  if (dryRun) {
    console.log("\n💡 To apply changes, run: bun scripts/convert-rules-to-mcp.ts");
  } else {
    console.log("\n🎉 Conversion complete! All CLI references converted to MCP tools.");
  }
}

// Export for use in template system
export const CLI_TO_MCP_MAPPING = CLI_TO_MCP_REPLACEMENTS;

// CLI execution
if (import.meta.main) {
  const args = process.argv.slice(2);
  const options: ConversionOptions = {
    dryRun: args.includes("--dry-run"),
    verbose: args.includes("--verbose"),
    filePattern: args.find(arg => arg.startsWith("--pattern="))?.split("=")[1]
  };

  await convertRulesToMCP(options);
}
