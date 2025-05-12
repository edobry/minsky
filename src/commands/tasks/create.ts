import { Command } from "commander";
import { TaskService } from "../../domain/tasks";
import { resolveRepoPath } from "../../domain/repo-utils";
import { SessionDB } from "../../domain/session";
import * as fs from "fs/promises";
import { join } from "path";

interface CreateOptions {
  session?: string;
  repo?: string;
  backend?: string;
  json?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

export const createCommand = new Command("create")
  .description("Create a new task from a specification document")
  .argument("<spec-path>", "Path to the task specification document")
  .option("--session <session>", "Session name to use for repo resolution")
  .option("--repo <repoPath>", "Path to a git repository (overrides session)")
  .option("--backend <backend>", "Specify task backend (markdown, github)")
  .option("--json", "Output task as JSON")
  .option("--dry-run", "Show what would happen without making changes")
  .option("--force", "Overwrite existing files if they exist")
  .action(async (specPath: string, options: CreateOptions) => {
    try {
      // Resolve repository path
      let workspacePath = options.repo;
      if (!workspacePath && options.session) {
        const sessionDB = new SessionDB();
        const session = await sessionDB.getSession(options.session);
        if (!session) {
          throw new Error(`Session "${options.session}" not found`);
        }
        workspacePath = session.repoUrl;
      }
      if (!workspacePath) {
        workspacePath = await resolveRepoPath({});
      }
      if (!workspacePath) {
        throw new Error(
          "Could not determine repository path. Please provide --repo or --session option."
        );
      }

      // In dry-run mode, we need to manually parse the spec file
      if (options.dryRun) {
        const fullSpecPath = specPath.startsWith("/") ? specPath : join(workspacePath, specPath);

        try {
          await fs.access(fullSpecPath);
        } catch (error) {
          throw new Error(`Spec file not found: ${specPath}`);
        }

        const specContent = await fs.readFile(fullSpecPath, "utf-8");
        const lines = specContent.split("\n");

        // Extract title from the first heading
        const titleLine = lines.find((line) => line.startsWith("# "));
        if (!titleLine) {
          throw new Error("Invalid spec file: Missing title heading");
        }

        // Support both title formats with improved regex
        const titleWithIdMatch = titleLine.match(/^# Task #(\d+): (.+)$/);
        const titleWithoutIdMatch = titleLine.match(/^# Task: (.+)$/);

        let title: string;
        let hasTaskId = false;
        let existingId: string | null = null;

        if (titleWithIdMatch && titleWithIdMatch[2]) {
          title = titleWithIdMatch[2];
          existingId = `#${titleWithIdMatch[1]}`;
          hasTaskId = true;
        } else if (titleWithoutIdMatch && titleWithoutIdMatch[1]) {
          title = titleWithoutIdMatch[1];
        } else {
          throw new Error(
            'Invalid spec file: Missing or invalid title. Expected formats: "# Task: Title" or "# Task #XXX: Title"'
          );
        }

        // Find the next available task ID or validate existing one
        const taskService = new TaskService({
          workspacePath,
          backend: options.backend,
        });

        let taskId: string;
        if (hasTaskId && existingId) {
          // Verify the task ID doesn't already exist
          const existingTask = await taskService.getTask(existingId);
          if (existingTask) {
            console.log(
              `Warning: Task ${existingId} already exists. Will use --force when creating.`
            );
          }
          taskId = existingId;
        } else {
          // Find the next available task ID
          const tasks = await taskService.listTasks();
          const maxId = tasks.reduce((max, task) => {
            const id = parseInt(task.id.slice(1));
            return id > max ? id : max;
          }, 0);
          taskId = `#${String(maxId + 1).padStart(3, "0")}`;
        }

        const taskIdNum = taskId.slice(1); // Remove the # prefix for file naming

        // Generate the standardized filename
        const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const newSpecPath = join("process", "tasks", `${taskIdNum}-${normalizedTitle}.md`);

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                id: taskId,
                title,
                status: "TODO",
                dryRun: true,
                specPath: newSpecPath,
              },
              null,
              2
            )
          );
        } else {
          console.log(`Would create task ${taskId}: ${title}`);
          console.log("Would update spec file:");

          if (!hasTaskId) {
            console.log(
              `  - Would change title from "${titleLine}" to "# Task ${taskId}: ${title}"`
            );
          }

          console.log(`  - Would rename file from "${specPath}" to "${newSpecPath}"`);
        }

        return;
      }

      // Create task service with resolved workspace path
      const taskService = new TaskService({
        workspacePath,
        backend: options.backend,
      });

      // Create the task
      const task = await taskService.createTask(specPath, {
        force: options.force,
      });

      // Output the result
      if (options.json) {
        console.log(JSON.stringify(task, null, 2));
      } else {
        console.log(`Task ${task.id} created: ${task.title}`);
        console.log("Spec file updated:");

        // Check if file was renamed by comparing paths
        const originalPath = specPath.startsWith("/") ? specPath : join(workspacePath, specPath);
        const newPath = join(workspacePath, task.specPath || "");

        if (originalPath !== newPath) {
          console.log(`  - File renamed from "${specPath}" to "${task.specPath}"`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
