import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { startSessionFromParams } from "../start-command";
import { log } from "../../../../utils/logger";

/**
 * Parameters for the session start command
 */
export const sessionStartCommandParams: CommandParameterMap = {
  name: {
    schema: z.string().min(1),
    description: "Name for the new session (optional, alternative to --task)",
    required: false,
  },
  task: {
    schema: z.string(),
    description: "Task ID to associate with the session (required if --description not provided)",
    required: false,
  },
  description: {
    schema: z.string().min(1),
    description: "Description for auto-created task (required if --task not provided)",
    required: false,
  },
  branch: {
    schema: z.string(),
    description: "Branch name to create (defaults to session name)",
    required: false,
  },
  repo: {
    schema: z.string(),
    description: "Repository path",
    required: false,
  },
  session: {
    schema: z.string(),
    description: "Deprecated: use name parameter instead",
    required: false,
  },
  json: {
    schema: z.boolean(),
    description: "Output in JSON format",
    required: false,
    defaultValue: false,
  },
  quiet: {
    schema: z.boolean(),
    description: "Suppress output except for the session directory path",
    required: false,
    defaultValue: false,
  },
  noStatusUpdate: {
    schema: z.boolean(),
    description: "Skip updating task status when starting a session with a task",
    required: false,
    defaultValue: false,
  },
  skipInstall: {
    schema: z.boolean(),
    description: "Skip automatic dependency installation",
    required: false,
    defaultValue: false,
  },
  packageManager: {
    schema: z.enum(["bun", "npm", "yarn", "pnpm"]),
    description: "Override the detected package manager",
    required: false,
  },
};

/**
 * Execute the session start command
 */
export async function executeSessionStartCommand(
  parameters: { [K in keyof typeof sessionStartCommandParams]: z.infer<typeof sessionStartCommandParams[K]["schema"]> },
  context: CommandExecutionContext
): Promise<any> {
  const { 
    name, 
    task, 
    description, 
    branch, 
    repo, 
    session, 
    json, 
    quiet, 
    noStatusUpdate, 
    skipInstall, 
    packageManager 
  } = parameters;

  const result = await startSessionFromParams({
    name: name || session, // Support deprecated session parameter
    task,
    description,
    branch,
    repo,
    json,
    quiet,
    noStatusUpdate,
    skipInstall,
    packageManager,
  });

  if (context.debug) {
    log.debug("Session start command executed successfully", { result });
  }

  return result;
} 
