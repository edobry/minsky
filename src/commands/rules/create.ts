import { Command } from "commander";
import { RuleService, type RuleMeta } from "../../domain/index.js";
import { promises as fs } from "fs";
import * as prompts from "@clack/prompts";
import { exit } from "../../utils/process.js";

export const createCommand = new Command("create")
  .description("Create a new Minsky rule")
  .argument("[ruleId]", "ID for the new rule (without .mdc extension)")
  .option("--name <n>", "Name for the rule")
  .option("--description <description>", "Description of what the rule does")
  .option("--globs <globs...>", "File patterns this rule applies to")
  .option("--always-apply", "Rule should always be applied")
  .option("--tags <tags...>", "Tags for categorization")
  .option("--format <format>", "Rule format (cursor or generic)", "cursor")
  .option("--content <file>", "File containing rule content (or - for stdin)")
  .option("--overwrite", "Overwrite existing rule if it exists")
  .option("--repo <path>", "Path to repository (default: current directory)")
  .option("--session <n>", "Use session for repo resolution")
  .action(async (ruleId, options) => {
    try {
      // Resolve the repo path using the domain module
      const { resolveRepoPath } = await import("../../domain/index.js");
      const repoPath = await resolveRepoPath({
        repo: options.repo,
        session: options.session,
      });

      // Initialize the rule service
      const ruleService = new RuleService(repoPath);

      // If no ruleId or options are provided, run in interactive mode
      if (!ruleId && !options.content) {
        await interactiveCreate(ruleService);
        return;
      }

      // Make sure we have a rule ID
      if (!ruleId) {
        prompts.log.error("Error: Rule ID is required for non-interactive mode");
        exit(1);
      }

      // Get the rule content
      let content = "";
      if (options.content) {
        if (options.content === "-") {
          // Read from stdin
          const { readFromStdin } = await import("./stdin-helpers.js");
          content = await readFromStdin();
        } else {
          // Read from file
          content = await fs.readFile(options.content, "utf-8");
        }
      } else {
        // Default content template
        content = `# ${options.name || ruleId}

${options.description || "No description provided."}

## Usage

Describe how and when to use this rule.

## Examples

\`\`\`typescript
// Example of code the rule applies to
\`\`\`
`;
      }

      // Prepare the metadata
      const meta: RuleMeta = {
        name: options.name,
        description: options.description,
        globs: options.globs,
        alwaysApply: options.alwaysApply || false,
        tags: options.tags,
      };

      // Create the rule
      const rule = await ruleService.createRule(ruleId, content, meta, {
        format: options.format as "cursor" | "generic",
        overwrite: options.overwrite,
      });

      prompts.log.success(`Rule '${rule.id}' created successfully.`);
      prompts.log.info(`Path: ${rule.path}`);
    } catch (error) {
      prompts.log.error(
        `Error creating rule: ${error instanceof Error ? error.message : String(error)}`
      );
      exit(1);
    }
  });

export function createCreateCommand(): Command {
  return createCommand;
}

// Interactive mode with @clack/prompts
async function interactiveCreate(ruleService: RuleService): Promise<void> {
  prompts.log.info("Creating a new Minsky rule");
  prompts.log.info("==========================");

  const ruleId = await prompts.text({
    message: "Rule ID (without .mdc extension)",
    validate: (value: string) => {
      if (!value) return "Rule ID is required";
      if (!/^[a-zA-Z0-9-_]+$/.test(value))
        return "Rule ID can only contain letters, numbers, hyphens, and underscores";
      return undefined;
    },
  });

  const format = await prompts.select({
    message: "Rule format",
    options: [
      { value: "cursor", label: "Cursor" },
      { value: "generic", label: "Generic (for other AI systems)" },
    ],
    initialValue: "cursor",
  });

  const name = await prompts.text({
    message: "Rule name",
    placeholder: "Optional",
  });

  const description = await prompts.text({
    message: "Rule description",
    placeholder: "What does this rule do?",
  });

  const globsInput = await prompts.text({
    message: "File globs (comma-separated patterns)",
    placeholder: "e.g., **/*.ts,**/*.js",
  });
  const globs = globsInput
    ? String(globsInput)
      .split(",")
      .map((g: string) => g.trim())
    : [];

  const tagsInput = await prompts.text({
    message: "Tags (comma-separated)",
    placeholder: "Optional",
  });
  const tags = tagsInput
    ? String(tagsInput)
      .split(",")
      .map((t: string) => t.trim())
    : [];

  const alwaysApply = await prompts.confirm({
    message: "Should this rule always be applied?",
    initialValue: false,
  });

  const useTemplate = await prompts.select({
    message: "Content source",
    options: [
      { value: "template", label: "Basic template" },
      { value: "stdin", label: "Enter content now" },
      { value: "file", label: "Read from a file" },
    ],
    initialValue: "template",
  });

  let content = "";

  if (useTemplate === "template") {
    content = `# ${String(name) || String(ruleId)}

${String(description) || "No description provided."}

## Usage

Describe how and when to use this rule.

## Examples

\`\`\`typescript
// Example of code the rule applies to
\`\`\`
`;
  } else if (useTemplate === "stdin") {
    prompts.log.info("\nEnter rule content (press Ctrl+D when finished):");
    const { readFromStdin } = await import("./stdin-helpers.js");
    content = await readFromStdin();
  } else if (useTemplate === "file") {
    const filePath = await prompts.text({
      message: "Path to file containing rule content",
      validate: (value: string) => {
        if (!value) return "File path is required";
        return undefined;
      },
    });

    try {
      content = await fs.readFile(String(filePath), "utf-8");
    } catch (error) {
      prompts.log.error(
        `Failed to read file: ${error instanceof Error ? error.message : String(error)}`
      );
      exit(1);
    }
  }

  const overwrite = await prompts.confirm({
    message: "Overwrite existing rule if it exists?",
    initialValue: false,
  });

  // Create the rule
  try {
    const rule = await ruleService.createRule(
      String(ruleId),
      content,
      {
        name: name ? String(name) : undefined,
        description: description ? String(description) : undefined,
        globs: globs.length > 0 ? globs : undefined,
        alwaysApply: Boolean(alwaysApply),
        tags: tags.length > 0 ? tags : undefined,
      },
      {
        format: String(format) as "cursor" | "generic",
        overwrite: Boolean(overwrite),
      }
    );

    prompts.log.success(`\nRule '${rule.id}' created successfully.`);
    prompts.log.info(`Path: ${rule.path}`);
  } catch (error) {
    prompts.log.error(
      `\nError creating rule: ${error instanceof Error ? error.message : String(error)}`
    );
    exit(1);
  }
}
