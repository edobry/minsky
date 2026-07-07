/**
 * Session File Commands
 *
 * Commands for file operations within session workspaces.
 * Provides CLI wrappers for session-aware MCP file tools.
 */
import { CommandCategory, type CommandDefinition } from "../../command-registry";
import { MinskyError, getErrorMessage } from "@minsky/domain/errors/index";
import { type SessionCommandDependencies, type LazySessionDeps, withErrorLogging } from "./types";
import { sessionEditFileCommandParams } from "./session-parameters";
import { readTextFile } from "@minsky/shared/fs";

interface SessionEditFileParams {
  name?: string;
  task?: string;
  repo?: string;
  json?: boolean;
  session?: string;
  path?: string;
  instruction?: string;
  patternFile?: string;
  dryRun?: boolean;
  createDirs?: boolean;
  fullReplace?: boolean;
  debug?: boolean;
}

async function resolveSessionId(
  deps: SessionCommandDependencies,
  params: SessionEditFileParams
): Promise<string> {
  if (params.session) {
    return params.session;
  }

  const currentSession = await deps.getCurrentSession(process.cwd());

  if (!currentSession) {
    throw new MinskyError(
      "No session specified and could not auto-detect from workspace. " +
        "Please provide --session <name> or run from within a session workspace."
    );
  }

  return currentSession;
}

async function readFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = "";

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

async function getEditPattern(params: SessionEditFileParams): Promise<string> {
  if (params.patternFile) {
    try {
      return await readTextFile(params.patternFile);
    } catch (error) {
      throw new MinskyError(
        `Failed to read pattern file '${params.patternFile}': ${getErrorMessage(error)}`
      );
    }
  }

  return readFromStdin();
}

/**
 * Thin CLI wrapper around the canonical apply-model operation
 * (`applySessionFileEditOperation`, `packages/domain/src/session/session-file-edit-operation.ts`).
 *
 * mt#2612: this used to be an independent reimplementation — despite its name and
 * doc-comment, it never called the MCP tool, threw "not yet implemented" for the
 * marker+existing-file case, and performed an unguarded full overwrite for the
 * marker-less+existing-file case (the mt#2400 FAIL-CLOSED guard was entirely
 * absent here). It now delegates the decision logic to the same domain function
 * `session.edit_file` (the MCP tool) uses, then builds the same diff/response
 * envelope shape this command has always returned.
 */
async function runSessionEditFileOperation(args: {
  sessionId: string;
  path: string;
  instructions: string;
  content: string;
  dryRun: boolean;
  createDirs: boolean;
  fullReplace: boolean;
  sessionProvider?: import("@minsky/domain/session/index").SessionProviderInterface;
}): Promise<Record<string, unknown>> {
  const { generateUnifiedDiff, generateDiffSummary } = await import("../../../../utils/diff");
  const { createSuccessResponse } = await import("@minsky/domain/schemas");
  const { applySessionFileEditOperation } = await import(
    "@minsky/domain/session/session-file-edit-operation"
  );

  const result = await applySessionFileEditOperation({
    sessionId: args.sessionId,
    path: args.path,
    content: args.content,
    instructions: args.instructions,
    dryRun: args.dryRun,
    createDirs: args.createDirs,
    fullReplace: args.fullReplace,
    sessionProvider: args.sessionProvider,
  });

  if (args.dryRun) {
    const diff = generateUnifiedDiff(result.originalContent, result.finalContent, args.path);
    const diffSummary = generateDiffSummary(result.originalContent, result.finalContent);

    return createSuccessResponse({
      timestamp: new Date().toISOString(),
      path: args.path,
      session: args.sessionId,
      resolvedPath: result.resolvedPath,
      dryRun: true,
      proposedContent: result.finalContent,
      diff,
      diffSummary,
      edited: result.fileExisted,
      created: !result.fileExisted,
    });
  }

  const bytesWritten = new TextEncoder().encode(result.finalContent).byteLength;

  return createSuccessResponse({
    timestamp: new Date().toISOString(),
    path: args.path,
    session: args.sessionId,
    resolvedPath: result.resolvedPath,
    bytesWritten,
    edited: result.fileExisted,
    created: !result.fileExisted,
  });
}

function formatDryRunMessage(result: Record<string, unknown>): string {
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

function formatResult(
  mcpResult: Record<string, unknown>,
  params: SessionEditFileParams
): Record<string, unknown> {
  if (params.json) {
    return { success: true, ...mcpResult };
  }

  if (mcpResult.dryRun) {
    return {
      success: true,
      type: "dry-run",
      path: mcpResult.path,
      session: mcpResult.session,
      diff: mcpResult.diff,
      diffSummary: mcpResult.diffSummary,
      proposedContent: params.debug ? mcpResult.proposedContent : undefined,
      message: formatDryRunMessage(mcpResult),
    };
  }

  return {
    success: true,
    type: "edit-applied",
    path: mcpResult.path,
    session: mcpResult.session,
    message: mcpResult.edited
      ? `✅ Successfully edited ${mcpResult.path}`
      : `✅ Successfully created ${mcpResult.path}`,
    bytesWritten: mcpResult.bytesWritten,
  };
}

export function createSessionEditFileCommand(getDeps: LazySessionDeps): CommandDefinition {
  return {
    id: "session.edit-file",
    category: CommandCategory.SESSION,
    name: "edit-file",
    description: "Edit a file within a session workspace using AI-powered pattern application",
    parameters: sessionEditFileCommandParams,
    execute: withErrorLogging("session.edit-file", async (params: Record<string, unknown>) => {
      const typedParams = params as SessionEditFileParams;
      try {
        const deps = await getDeps();
        const sessionId = await resolveSessionId(deps, typedParams);
        const content = await getEditPattern(typedParams);

        const mcpResult = await runSessionEditFileOperation({
          sessionId,
          path: typedParams.path ?? "",
          instructions: typedParams.instruction ?? "",
          content,
          dryRun: typedParams.dryRun || false,
          createDirs: typedParams.createDirs !== false,
          fullReplace: typedParams.fullReplace || false,
          sessionProvider: deps.sessionProvider,
        });

        return formatResult(mcpResult, typedParams);
      } catch (error) {
        throw new MinskyError(`Failed to edit file: ${getErrorMessage(error)}`, error);
      }
    }),
  };
}
