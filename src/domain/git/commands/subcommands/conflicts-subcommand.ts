import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import { ConflictScanner, type ConflictScanOptions } from "../../conflict-scanner";
import { log } from "../../../../utils/logger";
import { getCurrentWorkingDirectory } from "../../../../utils/process";

/**
 * Parameters for the conflicts command
 */
export const conflictsCommandParams: CommandParameterMap = {
  format: {
    schema: z.enum(["json", "text"]),
    description: "Output format for conflict results",
    required: false,
    defaultValue: "json",
  },
  context: {
    schema: z.number(),
    description: "Number of context lines to include around conflicts",
    required: false,
    defaultValue: 3,
  },
  files: {
    schema: z.string(),
    description: "File pattern to limit conflict scanning (e.g. '*.ts')",
    required: false,
  },
};

/**
 * Execute the conflicts command
 */
export async function executeConflictsCommand(
  parameters: {
    [K in keyof typeof conflictsCommandParams]: z.infer<(typeof conflictsCommandParams)[K]["schema"]>;
  },
  context: CommandExecutionContext
): Promise<string> {
  const { format, contextLines, files } = parameters;

  try {
    // Get current working directory as repository path
    const repoPath = getCurrentWorkingDirectory();

    if (context.debug) {
      log.debug("Executing conflicts command", { 
        repoPath, 
        format, 
        contextLines, 
        files 
      });
    }

    const options: ConflictScanOptions = {
      format: format as "json" | "text",
      context: contextLines,
      files,
    };

    const result = await ConflictScanner.scanRepository(repoPath, options);

    if (format === "text") {
      return ConflictScanner.formatAsText(result);
    } else {
      return JSON.stringify(result, null, 2);
    }
  } catch (error) {
    log.error("Error executing conflicts command", { error, parameters });
    
    if (format === "text") {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    } else {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }, null, 2);
    }
  }
} 
