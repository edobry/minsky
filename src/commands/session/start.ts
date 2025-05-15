import { Command } from "commander";
import { GitService } from "../../domain/git.js";
import { SessionDB, type SessionRecord } from "../../domain/session.js";
import { TaskService } from "../../domain/tasks.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRepoPath } from "../../domain/repo-utils.js";
import { startSession } from "./startSession.js";
import { normalizeTaskId } from "../../domain/tasks";
import { isSessionRepository } from "../../domain/workspace.js";
import { log } from "../../utils/logger.js";

export function createStartCommand(): Command {
  const gitService = new GitService();
  const sessionDB = new SessionDB();

  return new Command("start")
    .description("Start a new session with a cloned repository")
    .argument("[session]", "Session identifier (optional if --task is provided)")
    .option("-r, --repo <repo>", "Repository URL or local path to clone (optional)")
    .option(
      "-t, --task <taskId>",
      "Task ID to associate with the session (uses task ID as session name if provided)"
    )
    .option("-q, --quiet", "Output only the session directory path (for programmatic use)")
    .option("-b, --backend <type>", "Repository backend type (local, remote, github)", "auto")
    .option("--github-token <token>", "GitHub access token for authentication")
    .option("--github-owner <owner>", "GitHub repository owner (for github backend)")
    .option("--github-repo <repoName>", "GitHub repository name (for github backend)")
    .option("--branch <branch>", "Branch to checkout (for remote repositories)")
    .option("--repo-url <url>", "Remote repository URL (for remote and GitHub backends)")
    .option(
      "--auth-method <method>",
      "Authentication method for remote repositories (ssh, https, token)",
      "ssh"
    )
    .option("--depth <depth>", "Clone depth for remote repositories (shallow clone)", "1")
    .option("--no-status-update", "Skip automatic task status update to IN-PROGRESS")
    .action(
      async (
        sessionArg: string | undefined,
        options: {
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
        }
      ) => {
        try {
          const currentDir = globalThis.process.env.PWD || globalThis.process.cwd();
          const isInSession = await isSessionRepository(currentDir);
          if (isInSession) {
            throw new Error(
              "Cannot create a new session while inside a session workspace. Please return to the main workspace first."
            );
          }

          let determinedRepoPath: string;
          if (options.repo) {
            determinedRepoPath = options.repo;
          } else if (options.repoUrl && (options.backend === "remote" || options.backend === "github")) {
            determinedRepoPath = options.repoUrl;
          } else {
            try {
              determinedRepoPath = await resolveRepoPath({});
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              log.cliError(`Error starting session: Failed to resolve repository path: ${errorMsg}`);
              globalThis.process.exit(1);
              return; // Should be unreachable, for TSC
            }
          }
          // At this point, determinedRepoPath is guaranteed to be a string.

          let session = sessionArg;
          let taskId: string | undefined = undefined;

          if (options.task) {
            // Normalize the task ID format
            const normalized = normalizeTaskId(options.task);
            if (!normalized) {
              throw new Error(`Invalid task ID format: ${options.task}`);
            }
            taskId = normalized;

            // Verify the task exists
            const taskService = new TaskService({
              workspacePath: determinedRepoPath!, // Add non-null assertion
              backend: "markdown",
            });
            const task = await taskService.getTask(taskId!); // Add non-null assertion
            if (!task) {
              throw new Error(`Task ${taskId} not found`);
            }
            session = `task${taskId}`;
            const existingSessions = await sessionDB.listSessions();
            const taskSession = existingSessions.find((s: SessionRecord) => s.taskId === taskId);
            if (taskSession) {
              throw new Error(
                `A session for task ${taskId} already exists: '${taskSession.session}'`
              );
            }
          }

          const githubOptions = options.backend === "github" ? {
            token: options.githubToken,
            owner: options.githubOwner,
            repo: options.githubRepo,
          } : undefined;

          const remoteOpts = {
            authMethod: options.authMethod,
            depth: options.depth ? parseInt(options.depth, 10) : 1,
          };

          const result = await startSession({
            session,
            repo: determinedRepoPath, // Use the guaranteed string path
            taskId,
            backend: options.backend as "local" | "remote" | "github" | "auto",
            github: githubOptions,
            branch: options.branch,
            remote: remoteOpts,
            noStatusUpdate: options.statusUpdate === false,
          });

          if (options.quiet) {
            log.cli(result.cloneResult.workdir);
          } else {
            log.cli(`Session '${result.sessionRecord.session}' started.`);
            log.cli(`Repository cloned to: ${result.cloneResult.workdir}`);
            log.cli(`Branch '${result.branchResult.branch}' created.`);
            log.cli(`Backend: ${result.sessionRecord.backendType || "local"}`);
            if (taskId) {
              log.cli(`Associated with task: ${taskId}`);
              if (result.statusUpdateResult) {
                const { previousStatus, newStatus } = result.statusUpdateResult;
                log.cli(`Task status updated: ${previousStatus || "none"} → ${newStatus}`);
              } else if (options.statusUpdate === false) {
                log.cli("Task status update skipped (--no-status-update)");
              }
            }
            log.cli("\nTo navigate to this session's directory, run:");
            log.cli(`cd $(minsky session dir ${result.sessionRecord.session})`);
            log.cli("");
            log.cli(result.cloneResult.workdir);
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          log.cliError(`Error starting session: ${err.message}`);
          log.error("Session start error", {
            error: err.message,
            stack: err.stack
          });
          globalThis.process.exit(1);
        }
      }
    );
}
