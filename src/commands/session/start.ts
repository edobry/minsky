import { Command } from "commander";
import { GitService } from "../../domain/git.js";
import { SessionDB, type SessionRecord } from "../../domain/session.js";
import { TaskService } from "../../domain/tasks.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRepoPath } from "../../domain/repo-utils.js";
import { startSession } from "./startSession.js";
import { normalizeTaskId } from "../../utils/task-utils.js";
import { isSessionRepository } from "../../domain/workspace.js";

export function createStartCommand(): Command {
  const gitService = new GitService();
  const sessionDB = new SessionDB();

  return new Command("start")
    .description("Start a new session with a cloned repository")
    .argument("[session]", "Session identifier (optional if --task is provided)")
    .option("-r, --repo <repo>", "Repository URL or local path to clone (optional)")
    .option("-t, --task <taskId>", "Task ID to associate with the session (uses task ID as session name if provided)")
    .option("-q, --quiet", "Output only the session directory path (for programmatic use)")
    .option("-b, --backend <type>", "Repository backend type (local, remote, github)", "auto")
    .option("--github-token <token>", "GitHub access token for authentication")
    .option("--github-owner <owner>", "GitHub repository owner (for github backend)")
    .option("--github-repo <repoName>", "GitHub repository name (for github backend)")
    .option("--branch <branch>", "Branch to checkout (for remote repositories)")
    .option("--repo-url <url>", "Remote repository URL (for remote and GitHub backends)")
    .option("--auth-method <method>", "Authentication method for remote repositories (ssh, https, token)", "ssh")
    .option("--depth <depth>", "Clone depth for remote repositories (shallow clone)", "1")
    .option("--no-status-update", "Skip automatic task status update to IN-PROGRESS")
    .action(async (sessionArg: string | undefined, options: {
      repo?: string;
      task?: string;
      quiet?: boolean;
      backend?: "local" | "remote" | "github" | "auto";
      githubToken?: string;
      githubOwner?: string;
      githubRepo?: string;
      branch?: string;
      repoUrl?: string;
      authMethod?: "ssh" | "https" | "token";
      depth?: string;
      statusUpdate?: boolean;
    }) => {
      try {
        // Check if current directory is already within a session workspace
        const currentDir = globalThis.process.env.PWD || globalThis.process.cwd();
        const isInSession = await isSessionRepository(currentDir);
        if (isInSession) {
          throw new Error("Cannot create a new session while inside a session workspace. Please return to the main workspace first.");
        }

        // Default to repo-url if specified for remote/github backends
        let repoPath = options.repo;
        if (!repoPath && options.repoUrl && (options.backend === "remote" || options.backend === "github")) {
          repoPath = options.repoUrl;
        }

        // Otherwise try to resolve from current directory
        if (!repoPath) {
          try {
            repoPath = await resolveRepoPath({});
          } catch (err) {
            throw new Error(`--repo or --repo-url is required: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Handle the task ID if provided
        let session = sessionArg;
        let taskId: string | undefined = undefined;

        if (options.task) {
          // Normalize the task ID format
          taskId = normalizeTaskId(options.task);
          
          // Verify the task exists
          const taskService = new TaskService({
            workspacePath: repoPath,
            backend: "markdown" // Default to markdown backend
          });
          
          const task = await taskService.getTask(taskId);
          if (!task) {
            throw new Error(`Task ${taskId} not found`);
          }
          
          // Use the task ID as the session name
          session = `task${taskId}`;
          
          // Check if a session already exists for this task
          const existingSessions = await sessionDB.listSessions();
          const taskSession = existingSessions.find((s: SessionRecord) => s.taskId === taskId);
          
          if (taskSession) {
            throw new Error(`A session for task ${taskId} already exists: '${taskSession.session}'`);
          }
        }

        // Configure GitHub options if backend is github
        const github = options.backend === "github" ? {
          token: options.githubToken,
          owner: options.githubOwner,
          repo: options.githubRepo
        } : undefined;

        // Configure remote options
        const remoteOptions = {
          authMethod: options.authMethod,
          depth: options.depth ? parseInt(options.depth, 10) : 1
        };

        const result = await startSession({ 
          session, 
          repo: repoPath,
          taskId,
          backend: options.backend as "local" | "remote" | "github" | "auto",
          github,
          branch: options.branch,
          remote: remoteOptions,
          noStatusUpdate: options.statusUpdate === false
        });
        
        if (options.quiet) {
          // In quiet mode, output only the session directory path
          console.log(result.cloneResult.workdir);
        } else {
          // Standard verbose output for interactive use
          console.log(`Session '${result.sessionRecord.session}' started.`);
          console.log(`Repository cloned to: ${result.cloneResult.workdir}`);
          console.log(`Branch '${result.branchResult.branch}' created.`);
          console.log(`Backend: ${result.sessionRecord.backendType || "local"}`);
          
          if (taskId) {
            console.log(`Associated with task: ${taskId}`);
            
            // Show status update information if applicable
            if (result.statusUpdateResult) {
              const { previousStatus, newStatus } = result.statusUpdateResult;
              console.log(`Task status updated: ${previousStatus || "none"} → ${newStatus}`);
            } else if (options.statusUpdate === false) {
              console.log("Task status update skipped (--no-status-update)");
            }
          }
          
          console.log("\nTo navigate to this session's directory, run:");
          console.log(`cd $(minsky session dir ${result.sessionRecord.session})`);
          console.log("");
          console.log(result.cloneResult.workdir);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error("Error starting session:", err.message);
        globalThis.process.exit(1);
      }
    });
} 
