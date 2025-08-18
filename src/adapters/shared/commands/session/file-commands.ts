/**
 * Session File Commands
 *
 * Commands for file operations within session workspaces.
 * Provides CLI wrappers for session-aware MCP file tools.
 */
import { BaseSessionCommand, type SessionCommandDependencies } from "./base-session-command";
import { type CommandExecutionContext } from "../../command-registry";
import { MinskyError, getErrorMessage } from "../../../../errors/index";
import { sessionEditFileCommandParams } from "./session-parameters";
import * as fs from "fs/promises";

/**
 * Session Edit File Command
 *
 * CLI wrapper for session.edit_file MCP tool with support for:
 * - Reading edit patterns from stdin or --pattern-file
 * - Dry-run mode for previewing changes
 * - User-friendly output formatting
 */
export class SessionEditFileCommand extends BaseSessionCommand<any, any> {
  getCommandId(): string {
    return "session.edit-file";
  }

  getCommandName(): string {
    return "edit-file";
  }

  getCommandDescription(): string {
    return "Edit a file within a session workspace using AI-powered pattern application";
  }

  getParameterSchema(): Record<string, any> {
    return sessionEditFileCommandParams;
  }

  async executeCommand(params: any, context: CommandExecutionContext): Promise<any> {
    try {
      // Resolve session name (auto-detect from workspace if not provided)
      const sessionName = await this.resolveSessionName(params);

      // Get edit pattern from stdin or pattern file
      const content = await this.getEditPattern(params);

      // Call the MCP tool
      const mcpResult = await this.callSessionEditFileMcpTool({
        sessionName,
        path: params.path,
        instructions: params.instruction,
        content,
        dryRun: params.dryRun || false,
        createDirs: params.createDirs !== false, // Default to true
      });

      // Format and return the result
      return this.formatResult(mcpResult, params);

    } catch (error) {
      throw new MinskyError(
        `Failed to edit file: ${getErrorMessage(error)}`,
        error
      );
    }
  }

  /**
   * Resolve session name from parameter or auto-detect from workspace
   */
  private async resolveSessionName(params: any): Promise<string> {
    if (params.session) {
      return params.session;
    }

    // Auto-detect session from current workspace
    const { getCurrentSession } = await import("../../../../domain/workspace");
    const currentSession = await getCurrentSession();
    
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
  private async getEditPattern(params: any): Promise<string> {
    if (params.patternFile) {
      // Read from pattern file
      try {
        const content = await fs.readFile(params.patternFile, 'utf8');
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
      let content = '';
      
      // Check if stdin has data
      if (process.stdin.isTTY) {
        reject(new MinskyError(
          "No edit pattern provided. Please provide either:\n" +
          "  --pattern-file <path>  Read pattern from file\n" +
          "  <command> | minsky session edit-file  Pipe pattern via stdin\n\n" +
          "Example:\n" +
          "  echo '// ... existing code ...\\nmy changes\\n// ... existing code ...' | \\\n" +
          "    minsky session edit-file --path src/file.ts --instruction 'Add feature'"
        ));
        return;
      }

      process.stdin.setEncoding('utf8');
      
      process.stdin.on('data', (chunk) => {
        content += chunk;
      });

      process.stdin.on('end', () => {
        resolve(content.trim());
      });

      process.stdin.on('error', (error) => {
        reject(new MinskyError(`Failed to read from stdin: ${getErrorMessage(error)}`));
      });
    });
  }

  /**
   * Call the session.edit_file MCP tool
   */
  private async callSessionEditFileMcpTool(args: {
    sessionName: string;
    path: string; 
    instructions: string;
    content: string;
    dryRun: boolean;
    createDirs: boolean;
  }): Promise<any> {
    // Import the MCP command mapper and session edit tools
    const { CommandMapper } = await import("../../../../mcp/command-mapper");
    const { registerSessionEditTools } = await import("../../../../adapters/mcp/session-edit-tools");

    // Create a command mapper and register the session edit tools
    const commandMapper = new CommandMapper();
    registerSessionEditTools(commandMapper);

    // Get the session.edit_file command
    const editFileCommand = commandMapper.getCommand("session.edit_file");
    if (!editFileCommand) {
      throw new MinskyError("session.edit_file MCP tool not found");
    }

    // Call the MCP tool
    return await editFileCommand.handler(args);
  }

  /**
   * Format the result for CLI output
   */
  private formatResult(mcpResult: any, params: any): any {
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
  private formatDryRunMessage(result: any): string {
    const { diffSummary } = result;
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