/**
 * CLI adapter for session commands
 */
import { Command } from "commander";
import type {
  SessionListParams,
  SessionGetParams,
  SessionStartParams,
  SessionDirParams,
  SessionDeleteParams,
  SessionUpdateParams,
} from "../../schemas/session.js";
import { MinskyError } from "../../errors/index.js";
import {
  listSessionsFromParams,
  getSessionFromParams,
  startSessionFromParams,
  getSessionDirFromParams,
  deleteSessionFromParams,
  updateSessionFromParams,
} from "../../domain/index.js";

interface GetCurrentSessionConfig {
  getCurrentSession: () => Promise<string | null>;
}

/**
 * Creates the session start command
 */
export function createStartCommand(): Command {
  return new Command("start")
    .description("Start a new session")
    .argument("[name]", "Session name")
    .option("--repo <path>", "Repository path")
    .option("--task <taskId>", "Task ID to associate with this session")
    .option("--quiet", "Only output the session directory path")
    // Backend type option
    .option("--backend <type>", "Repository backend type (local, remote, github)")
    // Remote Git specific options
    .option("--repo-url <url>", "Remote repository URL for remote/github backends")
    .option("--auth-method <method>", "Authentication method for remote repository (ssh, https, token)")
    .option("--clone-depth <depth>", "Clone depth for remote repositories", (val: string) => parseInt(val, 10))
    // GitHub specific options
    .option("--github-token <token>", "GitHub access token for authentication")
    .option("--github-owner <owner>", "GitHub repository owner/organization")
    .option("--github-repo <repo>", "GitHub repository name")
    .action(async (name?: string, options?: { 
      repo?: string; 
      task?: string; 
      quiet?: boolean;
      backend?: "local" | "remote" | "github";
      repoUrl?: string;
      authMethod?: "ssh" | "https" | "token";
      cloneDepth?: number;
      githubToken?: string;
      githubOwner?: string;
      githubRepo?: string;
    }) => {
      try {
        // Convert CLI options to domain parameters
        const params = {
          name,
          repo: options?.repo,
          task: options?.task,
          quiet: options?.quiet || false,
          noStatusUpdate: false,
        } as SessionStartParams;
        
        // Add backend-specific parameters if provided
        if (options?.backend) {
          (params as any).backend = options.backend;
        }
        if (options?.repoUrl) {
          (params as any).repoUrl = options.repoUrl;
        }
        if (options?.authMethod) {
          (params as any).authMethod = options.authMethod;
        }
        if (options?.cloneDepth) {
          (params as any).cloneDepth = options.cloneDepth;
        }
        if (options?.githubToken) {
          (params as any).githubToken = options.githubToken;
        }
        if (options?.githubOwner) {
          (params as any).githubOwner = options.githubOwner;
        }
        if (options?.githubRepo) {
          (params as any).githubRepo = options.githubRepo;
        }

        // Call the domain function
        const result = await startSessionFromParams(params);

        // Output result
        if (options?.quiet) {
          // Get the session repo path for the quiet output
          const sessionDB = new (await import("../../domain/session.js")).SessionDB();
          const repoPath = await sessionDB.getRepoPath(result);
          console.log(repoPath);
        } else {
          console.log(`Session '${result.session}' created successfully.`);
          console.log(
            `Session directory: ${await new (await import("../../domain/session.js")).SessionDB().getRepoPath(result)}`
          );
          console.log(`Branch: ${result.branch}`);
          
          // Output backend-specific information if applicable
          if ((result as any).backendType) {
            console.log(`Backend type: ${(result as any).backendType}`);
          }
        }
      } catch (error) {
        if (error instanceof MinskyError) {
          // Only show the error message without the full JSON or stack trace
          console.error(`Error: ${error.message}`);
        } else {
          console.error(
            `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        process.exit(1);
      }
    });
} 
