import { z } from "zod";
import {
  type CommandParameterMap,
  type CommandExecutionContext,
} from "../../../../adapters/shared/command-registry";
import {
  scanSessionConflicts,
  formatSessionConflictResults,
  type SessionConflictScanOptions,
} from "../../../session/session-conflicts-operations";
import { analyzeConflictRegions } from "../../conflict-analysis-operations";
import { getCurrentSessionContext } from "../../../workspace";
import { log } from "../../../../utils/logger";
import { getCurrentWorkingDirectory } from "../../../../utils/process";
import { execAsync } from "../../../../utils/exec";

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
    [K in keyof typeof conflictsCommandParams]: z.infer<
      (typeof conflictsCommandParams)[K]["schema"]
    >;
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
        files,
      });
    }

    // Check if we're in a session context
    const sessionContext = await getCurrentSessionContext(repoPath);

    if (sessionContext) {
      // We're in a session - use session-specific logic
      const options: SessionConflictScanOptions = {
        format: format as "json" | "text",
        context: contextLines,
        files,
      };

      const result = await scanSessionConflicts({}, options);
      return formatSessionConflictResults(result, format as "json" | "text");
    } else {
      // We're not in a session - use general git conflict detection
      return await executeGeneralConflictsDetection(repoPath, {
        format: format as "json" | "text",
        context: contextLines,
        files,
      });
    }
  } catch (error) {
    log.error("Error executing conflicts command", { error, parameters });

    if (format === "text") {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    } else {
      return JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        },
        null,
        2
      );
    }
  }
}

/**
 * Execute general conflict detection for any git repository (not session-specific)
 */
async function executeGeneralConflictsDetection(
  repoPath: string,
  options: {
    format: "json" | "text";
    context?: number;
    files?: string;
  }
): Promise<string> {
  try {
    const files = await findFilesToScan(repoPath, options.files);
    const conflictedFiles: Array<{
      file: string;
      conflicts: number;
    }> = [];

    for (const file of files) {
      const regions = await analyzeConflictRegions(repoPath, file);
      if (regions.length > 0) {
        conflictedFiles.push({
          file,
          conflicts: regions.length,
        });
      }
    }

    const result = {
      repository: repoPath,
      timestamp: new Date().toISOString(),
      conflicts: conflictedFiles,
      summary: {
        totalFiles: conflictedFiles.length,
        totalConflicts: conflictedFiles.reduce((sum, f) => sum + f.conflicts, 0),
      },
    };

    if (options.format === "text") {
      return formatGeneralConflictResults(result);
    } else {
      return JSON.stringify(result, null, 2);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error("Error in general conflicts detection", { error: errorMsg, repoPath });
    
    if (options.format === "text") {
      return `Error: ${errorMsg}`;
    } else {
      return JSON.stringify({
        error: errorMsg,
        timestamp: new Date().toISOString(),
      }, null, 2);
    }
  }
}

/**
 * Format general conflict results as text
 */
function formatGeneralConflictResults(result: {
  repository: string;
  timestamp: string;
  conflicts: Array<{ file: string; conflicts: number }>;
  summary: { totalFiles: number; totalConflicts: number };
}): string {
  const output: string[] = [];

  output.push(`Git Conflict Scan Results`);
  output.push(`Repository: ${result.repository}`);
  output.push(`Scan Time: ${result.timestamp}`);
  output.push(`\nSummary:`);
  output.push(`  Total Files with Conflicts: ${result.summary.totalFiles}`);
  output.push(`  Total Conflict Regions: ${result.summary.totalConflicts}`);
  output.push("");

  if (result.conflicts.length === 0) {
    output.push("No conflicts found.");
    return output.join("\n");
  }

  for (const file of result.conflicts) {
    output.push(`File: ${file.file}`);
    output.push(`  Conflict regions: ${file.conflicts}`);
  }

  return output.join("\n");
}

/**
 * Find files to scan based on pattern or default git files
 */
async function findFilesToScan(repoPath: string, pattern?: string): Promise<string[]> {
  try {
    let command: string;

    if (pattern) {
      // Use find with pattern
      command = `find . -name "${pattern}" -type f`;
    } else {
      // Use git ls-files to get tracked files
      command = "git ls-files";
    }

    const { stdout } = await execAsync(command, { cwd: repoPath });
    const files = stdout
      .toString()
      .trim()
      .split("\n")
      .filter((file) => file.length > 0)
      .filter((file) => !file.startsWith(".git/"))
      .filter((file) => isTextFile(file));

    log.debug("Found files to scan", { count: files.length, pattern });
    return files;
  } catch (error) {
    log.error("Error finding files to scan", { error, repoPath, pattern });
    return [];
  }
}

/**
 * Check if a file is likely a text file (simple heuristic)
 */
function isTextFile(fileName: string): boolean {
  const textExtensions = [
    ".ts", ".js", ".tsx", ".jsx", ".json", ".md", ".txt", ".yml", ".yaml",
    ".xml", ".html", ".css", ".scss", ".less", ".py", ".java", ".c", ".cpp",
    ".h", ".hpp", ".cs", ".php", ".rb", ".go", ".rs", ".sh", ".bash", ".zsh",
    ".sql", ".toml", ".ini", ".conf", ".config",
  ];

  const binaryExtensions = [
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".pdf", ".zip",
    ".tar", ".gz", ".rar", ".7z", ".exe", ".dll", ".so", ".dylib", ".bin",
    ".o", ".obj", ".a", ".lib",
  ];

  const ext = fileName.toLowerCase().substring(fileName.lastIndexOf("."));

  // If it's explicitly a binary extension, skip it
  if (binaryExtensions.includes(ext)) {
    return false;
  }

  // If it's a known text extension or has no extension, include it
  return textExtensions.includes(ext) || !ext;
}

/**
 * FromParams wrapper for the conflicts command to match existing patterns
 */
export async function conflictsFromParams(params: {
  format?: "json" | "text";
  context?: number;
  files?: string;
}): Promise<{
  success: boolean;
  data?: string;
  error?: string;
}> {
  try {
    const repoPath = getCurrentWorkingDirectory();
    
    // Check if we're in a session context
    const sessionContext = await getCurrentSessionContext(repoPath);

    if (sessionContext) {
      // We're in a session - use session-specific logic
      const options: SessionConflictScanOptions = {
        format: params.format || "json",
        context: params.context || 3,
        files: params.files,
      };

      const result = await scanSessionConflicts({}, options);
      const formattedOutput = formatSessionConflictResults(result, options.format);

      return {
        success: true,
        data: formattedOutput,
      };
    } else {
      // We're not in a session - use general git conflict detection
      const output = await executeGeneralConflictsDetection(repoPath, {
        format: params.format || "json",
        context: params.context || 3,
        files: params.files,
      });

      return {
        success: true,
        data: output,
      };
    }
  } catch (error) {
    log.error("Error executing conflicts command", { error, params });
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
