import { Command } from "commander";
import { resolveRepoPath, RepoResolutionOptions } from "../../utils/repo";
import { initializeProject } from "../../domain/init";
import * as p from "@clack/prompts";
import fs from "fs";
import path from "path";

export function createInitCommand(): Command {
  return new Command("init")
    .description("Initialize a project for Minsky")
    .option("-r, --repo <path>", "Repository path (defaults to current directory)")
    .option("-s, --session <name>", "Session name to get repo path from")
    .option("-b, --backend <type>", "Task backend type (tasks.md or tasks.csv)")
    .option("-f, --rule-format <format>", "Rule format (cursor or generic)")
    .action(async (options: {
      repo?: string,
      session?: string,
      backend?: string,
      ruleFormat?: string
    }) => {
      try {
        p.intro("Initialize Minsky in your project");

        // Resolve repo path
        let repoPath: string;
        try {
          repoPath = await resolveRepoPath({
            repo: options.repo,
            session: options.session
          });
        } catch (error) {
          console.error("Error resolving repository path:", 
            error instanceof Error ? error.message : String(error));
          process.exit(1);
        }

        // If repo path was resolved without explicit flags, confirm with user
        if (!options.repo && !options.session) {
          const confirm = await p.confirm({
            message: `Using current directory: ${repoPath}\nContinue?`,
            initialValue: true,
          });

          if (p.isCancel(confirm) || !confirm) {
            p.cancel("Operation cancelled");
            process.exit(0);
          }
        }

        // Get backend type if not provided
        let backend = options.backend;
        if (!backend) {
          const backendChoice = await p.select({
            message: "Choose a task backend",
            options: [
              { value: "tasks.md", label: "tasks.md - Markdown-based task tracking" },
              { value: "tasks.csv", label: "tasks.csv - CSV-based task tracking (not implemented yet)" },
            ],
          });

          if (p.isCancel(backendChoice)) {
            p.cancel("Operation cancelled");
            process.exit(0);
          }

          backend = String(backendChoice);
        }

        // Get rule format if not provided
        let ruleFormat = options.ruleFormat;
        if (!ruleFormat) {
          const formatChoice = await p.select({
            message: "Choose a rule format",
            options: [
              { value: "cursor", label: "cursor - Store rules in .cursor/rules" },
              { value: "generic", label: "generic - Store rules in .ai/rules" },
            ],
          });

          if (p.isCancel(formatChoice)) {
            p.cancel("Operation cancelled");
            process.exit(0);
          }

          ruleFormat = String(formatChoice);
        }

        // Init project
        await initializeProject({
          repoPath,
          backend: backend as "tasks.md" | "tasks.csv",
          ruleFormat: ruleFormat as "cursor" | "generic"
        });

        p.outro("Project initialized successfully!");
      } catch (error) {
        console.error("Error initializing project:", 
          error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
} 
