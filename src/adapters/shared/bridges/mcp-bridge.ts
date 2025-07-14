/**
 * MCP Bridge
 *
 * This module bridges the shared command registry with the Minsky Control Plane (MCP),
 * allowing shared commands to be executed via MCP requests.
 */
import { sharedCommandRegistry, type CommandExecutionContext } from "../command-registry";
import { 
  validateMcpCommandRequest, 
  validateCommandDefinition, 
  validateCommandRegistry,
  validateParameterDefinition,
  validateZodParseResult,
  type McpCommandRequest,
  type McpCommandResponse,
  type ParameterDefinition,
  type ZodParseResult 
} from "../../../schemas/runtime";
import { validateError } from "../../../schemas/error";
import { ensureError } from "../../../errors/index.js";

/**
 * MCP-specific execution context
 */
export interface McpExecutionContext extends CommandExecutionContext {
  interface: "mcp";
  mcpSpecificData?: Record<string, any>;
}

/**
 * Execute a shared command via MCP protocol
 */
export async function executeMcpCommand(request: McpCommandRequest): Promise<McpCommandResponse> {
  try {
    // Validate the request
    const validatedRequest = validateMcpCommandRequest(request);
    
    // Validate the command registry
    const registry = validateCommandRegistry(sharedCommandRegistry);
    const commandDef = registry.getCommand(validatedRequest.commandId);
    
    if (!commandDef) {
      return {
        success: false,
        error: {
          message: `Command not found: ${validatedRequest.commandId}`,
          type: "COMMAND_NOT_FOUND",
        },
      };
    }

    // Validate the command definition
    const validatedCommandDef = validateCommandDefinition(commandDef);

    // Parameter validation and parsing
    const parsedParams: Record<string, any> = {};
    const validationErrors: Record<string, string[]> = {};

    for (const paramName in validatedCommandDef.parameters) {
      const paramDef = validateParameterDefinition(validatedCommandDef.parameters[paramName]);
      const rawValue = validatedRequest.parameters[paramName];

      if (rawValue === undefined && paramDef.required && paramDef.defaultValue === undefined) {
        if (!validationErrors[paramName]) validationErrors[paramName] = [];
        validationErrors[paramName].push("Parameter is required.");
        continue;
      }

      const valueToParse = rawValue === undefined ? paramDef.defaultValue : rawValue;

      if (valueToParse === undefined) {
        continue;
      }

      const parseResult = paramDef.schema.safeParse(valueToParse);
      const validatedParseResult = validateZodParseResult(parseResult);
      
      if (validatedParseResult.success) {
        parsedParams[paramName] = validatedParseResult.data;
      } else {
        if (!validationErrors[paramName]) {
          validationErrors[paramName] = [];
        }
        
        // Process validation errors
        const errorObj = validatedParseResult.error;
        if (errorObj && errorObj.errors) {
          errorObj.errors.forEach((validationIssue) => {
            validationErrors[paramName].push(validationIssue.message);
          });
        } else {
          validationErrors[paramName].push("Invalid value, and Zod error details are unavailable.");
        }
      }
    }

    if (Object.keys(validationErrors).length > 0) {
      return {
        success: false,
        error: {
          message: "Parameter validation failed.",
          type: "VALIDATION_ERROR",
          details: validationErrors,
        },
      };
    }

    // Execute the command
    const context: McpExecutionContext = {
      interface: "mcp",
      mcpSpecificData: validatedRequest.mcpContext,
    };

    // Use the handler function if available, otherwise throw error
    if (validatedCommandDef.handler) {
      const result = await validatedCommandDef.handler(parsedParams, context);
      return {
        success: true,
        result,
      };
    } else {
      return {
        success: false,
        error: {
          message: "Command handler not available",
          type: "EXECUTION_ERROR",
        },
      };
    }
  } catch (error) {
    const validatedError = validateError(error);
    
    // Create a safe reference to the validated request for error handling
    let debugMode = false;
    try {
      const validatedRequest = validateMcpCommandRequest(request);
      debugMode = validatedRequest.debug || false;
    } catch {
      // Ignore validation errors in error handling
    }
    
    return {
      success: false,
      error: {
        message: validatedError.message,
        type: "EXECUTION_ERROR",
        details: validatedError.stack,
        stack: debugMode ? validatedError.stack : undefined,
      },
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
