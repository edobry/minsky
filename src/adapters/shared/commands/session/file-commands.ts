/**
 * Session File Commands
 *
 * Commands for file operations within session workspaces.
 * Provides CLI wrappers for session-aware MCP file tools.
 */
import {
  BaseSessionCommand,
  type BaseSessionCommandParams,
  type SessionCommandDependencies,
} from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { sessionEditFileCommandParams } from "./session-parameters";
import * as fs from "fs/promises";
import { readTextFile } from "../../../../utils/fs";

/**
 * Session Edit File Command
 *
 * CLI wrapper for session.edit_file MCP tool with support for:
 * - Reading edit patterns from stdin or --pattern-file
 * - Dry-run mode for previewing changes
 * - User-friendly output formatting
 */
/**
 * Parameters for session edit-file command
 */
interface SessionEditFileParams extends BaseSessionCommandParams {
  session?: string;
  path?: string;
  instruction?: string;
  patternFile?: string;
  dryRun?: boolean;
  createDirs?: boolean;
  debug?: boolean;
}

export class SessionEditFileCommand extends BaseSessionCommand<
  SessionEditFileParams,
  Record<string, unknown>
> {
  getCommandId(): string {
    return "session.edit-file";
  }

  getCommandName(): string {
    return "edit-file";
  }

  getCommandDescription(): string {
    return "Edit a file within a session workspace using AI-powered pattern application";
  }

  getParameterSchema(): Record<string, unknown> {
    return sessionEditFileCommandParams;
  }

  async executeCommand(
    params: SessionEditFileParams,
    context: CommandExecutionContext
  ): Promise<Record<string, unknown>> {
    try {
      // Resolve session ID (auto-detect from workspace if not provided)
      const sessionId = await this.resolveSessionId(params);

      // Get edit pattern from stdin or pattern file
      const content = await this.getEditPattern(params);

      // Call the MCP tool
      const mcpResult = await this.callSessionEditFileMcpTool({
        sessionId,
        path: params.path ?? "",
        instructions: params.instruction ?? "",
        content,
        dryRun: params.dryRun || false,
        createDirs: params.createDirs !== false, // Default to true
      });

      // Format and return the result
      return this.formatResult(mcpResult, params);
    } catch (error) {
      throw new MinskyError(`Failed to edit file: ${getErrorMessage(error)}`, error);
    }
  }

  /**
   * Resolve session ID from parameter or auto-detect from workspace
   */
  private async resolveSessionId(params: SessionEditFileParams): Promise<string> {
    if (params.session) {
      return params.session;
    }

    // Auto-detect session from current workspace
    const { getCurrentSession } = await import("../../../../domain/workspace");
    const { execAsync } = await import("../../../../utils/exec");
    const sessionDB = this.deps.sessionProvider!;
    const currentSession = await getCurrentSession(process.cwd(), execAsync, sessionDB);

    if (!currentSession) {
      throw new MinskyError(
        "No session specified and could not auto-detect from workspace. " +
          "Please provide --session <name> or run from within a session workspace."
      );
    }

    return currentSession;
  }

  /**
   * Get edit pattern from stdin or pattern file
   */
  private async getEditPattern(params: SessionEditFileParams): Promise<string> {
    if (params.patternFile) {
      // Read from pattern file
      try {
        const content = await readTextFile(params.patternFile);
        return content;
      } catch (error) {
        throw new MinskyError(
          `Failed to read pattern file '${params.patternFile}': ${getErrorMessage(error)}`
        );
      }
    }

    // Read from stdin
    return this.readFromStdin();
  }

  /**
   * Read content from stdin
   */
  private async readFromStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
      let content = "";

      // Check if stdin has data
      if (process.stdin.isTTY) {
        reject(
          new MinskyError(
            "No edit pattern provided. Please provide either:\n" +
              "  --pattern-file <path>  Read pattern from file\n" +
              "  <command> | minsky session edit-file  Pipe pattern via stdin\n\n" +
              "Example:\n" +
              "  echo '// ... existing code ...\\nmy changes\\n// ... existing code ...' | \\\n" +
              "    minsky session edit-file --path src/file.ts --instruction 'Add feature'"
          )
        );
        return;
      }

      (process.stdin as NodeJS.ReadStream & { setEncoding(encoding: string): void }).setEncoding(
        "utf8"
      );

      process.stdin.on("data", (chunk) => {
        content += chunk;
      });

      process.stdin.on("end", () => {
        resolve(content.trim());
      });

      process.stdin.on("error", (error) => {
        reject(new MinskyError(`Failed to read from stdin: ${getErrorMessage(error)}`));
      });
    });
  }

  /**
   * Call the session.edit_file MCP tool directly
   */
  private async callSessionEditFileMcpTool(args: {
    sessionId: string;
    path: string;
    instructions: string;
    content: string;
    dryRun: boolean;
    createDirs: boolean;
  }): Promise<Record<string, unknown>> {
    // Import the required modules for session edit functionality
    const { writeFile, stat } = await import("fs/promises");
    const { dirname } = await import("path");
    const { mkdir } = await import("fs/promises");
    const { SessionPathResolver } = await import(
      "../../../../domain/session/session-path-resolver"
    );
    const { generateUnifiedDiff, generateDiffSummary } = await import("../../../../utils/diff");
    const { createSuccessResponse } = await import("../../../../domain/schemas");

    // Create path resolver
    const pathResolver = new SessionPathResolver();
    const resolvedPath = await pathResolver.resolvePath(args.sessionId, args.path);

    // Check if file exists
    let fileExists = false;
    let originalContent = "";

    try {
      await stat(resolvedPath);
      fileExists = true;
      originalContent = await readTextFile(resolvedPath);
    } catch (error) {
      // File doesn't exist - that's ok for new files
      fileExists = false;
    }

    // If file doesn't exist and we have existing code markers, that's an error
    if (!fileExists && args.content.includes("// ... existing code ...")) {
      throw new MinskyError(
        `Cannot apply edits with existing code markers to non-existent file: ${args.path}`
      );
    }

    let finalContent: string;

    if (fileExists && args.content.includes("// ... existing code ...")) {
      // For now, throw an error for edit patterns - this would need the fast-apply integration
      throw new MinskyError(
        "Edit pattern application is not yet implemented in the CLI wrapper. " +
          "Please use the MCP tool directly for pattern-based edits."
      );
    } else {
      // Direct write for new files or complete replacements
      finalContent = args.content;
    }

    // Handle dry-run mode
    if (args.dryRun) {
      // Generate diff for dry-run mode
      const diff = generateUnifiedDiff(originalContent, finalContent, args.path);
      const diffSummary = generateDiffSummary(originalContent, finalContent);

      return createSuccessResponse({
        timestamp: new Date().toISOString(),
        path: args.path,
        session: args.sessionId,
        resolvedPath,
        dryRun: true,
        proposedContent: finalContent,
        diff,
        diffSummary,
        edited: fileExists,
        created: !fileExists,
      });
    }

    // Create parent directories if needed
    if (args.createDirs) {
      await mkdir(dirname(resolvedPath), { recursive: true });
    }

    // Write the file
    await writeFile(resolvedPath, finalContent, "utf8");
    const bytesWritten = new TextEncoder().encode(finalContent).byteLength;

    return createSuccessResponse({
      timestamp: new Date().toISOString(),
      path: args.path,
      session: args.sessionId,
      resolvedPath,
      bytesWritten,
      edited: fileExists,
      created: !fileExists,
    });
  }

  /**
   * Format the result for CLI output
   */
  private formatResult(
    mcpResult: Record<string, unknown>,
    params: SessionEditFileParams
  ): Record<string, unknown> {
    if (params.json) {
      return this.createSuccessResult(mcpResult);
    }

    if (mcpResult.dryRun) {
      // Dry-run mode: show diff and summary
      return this.createSuccessResult({
        type: "dry-run",
        path: mcpResult.path,
        session: mcpResult.session,
        diff: mcpResult.diff,
        diffSummary: mcpResult.diffSummary,
        proposedContent: params.debug ? mcpResult.proposedContent : undefined,
        message: this.formatDryRunMessage(mcpResult),
      });
    } else {
      // Normal mode: show success message
      return this.createSuccessResult({
        type: "edit-applied",
        path: mcpResult.path,
        session: mcpResult.session,
        message: mcpResult.edited
          ? `✅ Successfully edited ${mcpResult.path}`
          : `✅ Successfully created ${mcpResult.path}`,
        bytesWritten: mcpResult.bytesWritten,
      });
    }
  }

  /**
   * Format dry-run output message
   */
  private formatDryRunMessage(result: Record<string, unknown>): string {
    const diffSummary = result.diffSummary as
      | { linesAdded: number; linesRemoved: number; linesChanged: number; totalLines: number }
      | undefined;
    const action = result.created ? "create" : "edit";

    let message = `🔍 Dry-run: Would ${action} ${result.path}\n\n`;

    if (diffSummary) {
      message += `📊 Changes summary:\n`;
      message += `  +${diffSummary.linesAdded} lines added\n`;
      message += `  -${diffSummary.linesRemoved} lines removed\n`;
      if (diffSummary.linesChanged > 0) {
        message += `  ~${diffSummary.linesChanged} lines changed\n`;
      }
      message += `  Total: ${diffSummary.totalLines} lines\n\n`;
    }

    if (result.diff) {
      message += `📝 Unified diff:\n${result.diff}\n\n`;
    }

    message += `💡 To apply these changes, run the same command without --dry-run`;

    return message;
  }
}

/**
 * Factory function for creating session edit-file command
 */
export const createSessionEditFileCommand = (deps?: SessionCommandDependencies) =>
  new SessionEditFileCommand(deps);
