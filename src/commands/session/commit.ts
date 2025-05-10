#!/usr/bin/env bun

import { Command } from "commander";
import { GitService } from "../../domain/git.js";
import { SessionDB } from "../../domain/session.js";
import { getCurrentSession as defaultGetCurrentSession } from "../../domain/workspace.js";
import { resolveRepoPath } from "../../domain/repo-utils.js";
import { createInterface } from "readline";
import { promisify } from "util";

// Helper function to prompt for commit message
async function defaultPromptForMessage(): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise<string>((resolve) => {
    rl.question("Enter commit message: ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export interface CommitCommandDependencies {
  gitService?: GitService;
  sessionDb?: SessionDB;
  getCurrentSession?: typeof defaultGetCurrentSession;
  promptForMessage?: typeof defaultPromptForMessage;
  isTestEnvironment?: boolean; // Flag to indicate test environment
}

export function createCommitCommand(dependencies?: CommitCommandDependencies): Command {
  const gitService = dependencies?.gitService || new GitService();
  const sessionDb = dependencies?.sessionDb || new SessionDB();
  const getCurrentSession = dependencies?.getCurrentSession || defaultGetCurrentSession;
  const promptForMessage = dependencies?.promptForMessage || defaultPromptForMessage;
  const isTestEnvironment = dependencies?.isTestEnvironment || false;

  return new Command("commit")
    .description("Stage, commit, and optionally push all changes for a session")
    .argument("[session]", "Session identifier (defaults to current session)")
    .option("-m, --message <message>", "Commit message")
    .option("-r, --repo <path>", "Repository path")
    .option("--no-push", "Skip pushing changes after commit")
    .option("--ignore-workspace", "Bypass workspace auto-detection")
    .action(async (sessionArg: string | undefined, options: {
      message?: string;
      repo?: string;
      push?: boolean;
      ignoreWorkspace?: boolean;
    }) => {
      try {
        // Get session info and workdir
        let workdir: string;
        let sessionRecord;

        if (sessionArg) {
          sessionRecord = await sessionDb.getSession(sessionArg);
          if (!sessionRecord) {
            throw new Error(`Session '${sessionArg}' not found.`);
          }
          workdir = gitService.getSessionWorkdir(sessionRecord.repoName, sessionArg);
        } else if (!options.ignoreWorkspace) {
          // Try to detect current session from working directory
          const currentSessionName = await getCurrentSession();
          if (!currentSessionName) {
            throw new Error("No session specified and not in a session workspace. Please provide a session name.");
          }
          sessionRecord = await sessionDb.getSession(currentSessionName);
          if (!sessionRecord) {
            throw new Error(`Current session '${currentSessionName}' not found in session database.`);
          }
          workdir = gitService.getSessionWorkdir(sessionRecord.repoName, sessionRecord.session);
        } else {
          // Use provided repo path or try to resolve from current directory
          workdir = await resolveRepoPath({ repo: options.repo });
        }

        // Check if there are changes to commit
        const status = await gitService.getStatus(workdir);
        const hasChanges = status.modified.length > 0 || status.untracked.length > 0 || status.deleted.length > 0;
        
        if (!hasChanges) {
          throw new Error("No changes to commit. Working directory is clean.");
        }

        // Get commit message
        let message = options.message;
        if (!message) {
          message = await promptForMessage();
          if (!message.trim()) {
            throw new Error("Commit message cannot be empty.");
          }
        }

        // Add task ID prefix if available
        if (sessionRecord && sessionRecord.taskId) {
          message = `[${sessionRecord.taskId.startsWith("#") ? sessionRecord.taskId : "#" + sessionRecord.taskId}] ${message}`;
        }

        // Stage all changes
        console.log("Staging changes...");
        await gitService.stageAll(workdir);

        // Commit changes
        console.log("Committing changes...");
        const commitHash = await gitService.commit(message, workdir);
        console.log(`Changes committed successfully (${commitHash}).`);

        // Push changes if not disabled
        if (options.push !== false) {
          console.log("Pushing changes...");
          await gitService.push({
            repoPath: workdir,
            session: sessionRecord?.session
          });
          console.log("Changes pushed successfully.");
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error("Error:", err.message);
        
        // In test environment, rethrow the error so tests can catch it
        if (isTestEnvironment) {
          throw err;
        }
        
        process.exit(1);
      }
    });
} 
