/**
 * MCP Bridge
 *
 * This module bridges the shared command registry with the Minsky Control Plane (MCP),
 * allowing shared commands to be executed via MCP requests.
 */
import { type ZodIssue } from "zod";
import { sharedCommandRegistry, type CommandExecutionContext } from "../command-registry.js";
import { ensureError } from "../../../errors/index.js";
// Assuming MCP requests come in a specific format, e.g., FastMCP
// For this example, let's define a placeholder for MCP request and response types.

/**
 * Represents a generic MCP command request.
 */
export interface McpCommandRequest {
  commandId: string;
  parameters: Record<string, any>;
  // MCP-specific _context, like user auth, request ID, etc.
  mcpContext?: Record<string, any>;
  // Global options like debug or format might also be part of the MCP request payload
  debug?: boolean;
  format?: string;
}

/**
 * Represents a generic MCP command response.
 */
export interface McpCommandResponse {
  success: boolean;
  result?: any;
  error?: {
    message: string;
    type?: string;
    details?: any;
    stack?: string; // if debug is enabled
  };
}

/**
 * MCP-specific execution context.
 */
export interface McpExecutionContext extends CommandExecutionContext {
  interface: "mcp";
  mcpSpecificData?: Record<string, any>; // Placeholder for any MCP-specific data
}

/**
 * Validates and executes a command received from the MCP.
 *
 * @param request The MCP command request.
 * @returns A promise that resolves to an MCP command response.
 */
export async function executeMcpCommand(request: McpCommandRequest): Promise<McpCommandResponse> {
  const commandDef = (sharedCommandRegistry as any).getCommand((request as any).commandId);

  if (!commandDef) {
    const errorResponse = {
      success: false,
      error: {
        message: `Command with ID '${(request as any).commandId}' not found.`,
        type: "COMMAND_NOT_FOUND",
      },
    };
    // MCP error handler might log this or handle it differently before returning
    // For now, directly return for simplicity
    return errorResponse;
  }

  try {
    // Prepare execution context for the shared command
    const _context: McpExecutionContext = {
      interface: "mcp",
      debug: !!(request as any).debug,
      format: (request as any).format,
      mcpSpecificData: (request as any).mcpContext, // Pass along any MCP specific _context
    };

    // Validate incoming parameters against the command's Zod schemas
    // This part is crucial and assumes commandDef.parameters is a Zod schema map
    const parsedParams: Record<string, any> = {};
    const validationErrors: Record<string, string[]> = {};

    for (const paramName in (commandDef as any).parameters) {
      const paramDef = (commandDef as any).parameters[paramName];
      const rawValue = (request as any).parameters[paramName];

      if (rawValue === undefined && (paramDef as any).required && (paramDef as any).defaultValue === undefined) {
        if (!validationErrors[paramName]) validationErrors[paramName] = [];
        (validationErrors[paramName] as any).push("Parameter is required.");
        continue;
      }

      const valueToParse = rawValue === undefined ? (paramDef as any).defaultValue : rawValue;

      if (valueToParse === undefined) {
        continue;
      }

      const parseResult = (paramDef.schema as any).safeParse(valueToParse);
      if ((parseResult as any).success) {
        parsedParams[paramName] = (parseResult as any).data;
      } else {
        if (!validationErrors[paramName]) {
          validationErrors[paramName] = []; // Initialize if not already an array
        }
        // Ensure parseResult.error and parseResult.error.errors exist before iterating
        if ((parseResult as any).error && (parseResult.error as any).errors) {
          // Ensure array exists before pushing to it within the callback
          const errors = validationErrors[paramName];
          (parseResult.error.errors as any).forEach((validationIssue: any) => {
            (errors as any).push((validationIssue as any).message);
          });
        } else {
          // Fallback generic error if Zod's error structure is unexpected
          (validationErrors[paramName] as any).push("Invalid value, and Zod error details are unavailable.");
        }
      }
    }

    if ((Object.keys(validationErrors) as any).length > 0) {
      return {
        success: false,
        error: {
          message: "Parameter validation failed.",
          type: "VALIDATION_ERROR",
          details: validationErrors,
        },
      };
    }

    // Execute the command with validated parameters
    const result = await (commandDef as any).execute(parsedParams as any, _context); // Cast as any due to generic complexity

    // Format response for MCP
    // In a real scenario, a shared response formatter might be used based on context.format
    return {
      success: true,
      result: result,
    };
  } catch (error: any) {
    const ensuredError = ensureError(error as any);

    const formattedMcpErrorResponse = {
      message: (ensuredError as any).message || "An unexpected error occurred during MCP command execution.",
      type:
        (ensuredError as any).constructor &&
        (ensuredError.constructor as any).name !== "Error" &&
        (ensuredError.constructor as any).name !== "Object"
          ? (ensuredError.constructor as any).name
          : "MCP_EXECUTION_ERROR",
      stack: (request as any).debug ? (ensuredError as any).stack : undefined as any,
      details: (ensuredError as any)?.details || (ensuredError as any)?.cause || undefined,
    };

    // Optional: Log the error server-side using a dedicated MCP error logger if available
    // const mcpErrorLogger = getErrorHandler("mcp");
    // mcpErrorLogger.logDetailedError(_ensuredError, request); // Example method

    return {
      success: false,
      error: formattedMcpErrorResponse,
    };
  }
}

// Example of how this might be registered or used with an MCP server (e.g., FastMCP)
// This is highly dependent on the MCP framework being used.
/*
export function registerMcpCommands(mcpServer: FastMcpServer) {
  const commands = sharedCommandRegistry.getAllCommands();
  commands.forEach(commandDef => {
    mcpServer.addCommandHandler(commandDef.id, async (payload: unknown) => {
      const request: McpCommandRequest = {
        commandId: commandDef.id,
        _parameters: payload.params || {},
        mcpContext: payload.context || {},
        debug: !!payload.debug,
        format: payload.format as string || "json",
      };
      return executeMcpCommand(request);
    });
  });
}
*/
