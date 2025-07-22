/**
 * Interface-Layer Session Context Resolution
 *
 * This implements the clean architecture solution where session context resolution
 * is handled at the interface adapter layer, keeping domain logic pure.
 */

import { log } from "../utils/logger";
import { MinskyError, ValidationError } from "../errors/index";

/**
 * Session context resolution result
 */
export interface SessionContext {
  session: string;
  resolvedBy: "explicit" | "cli-autodetect" | "task-id";
}

/**
 * Interface adapter for CLI session context resolution
 * Handles auto-detection from working directory
 */
export class CLISessionContextResolver {
  /**
   * Resolve session context for CLI interface
   * Auto-detects session from working directory when possible
   */
  static resolveSessionContext(params: any, workingDir?: string): any {
    // If session is explicitly provided via name parameter, use it
    if (params.name) {
      return {
        ...params,
        session: params.name,
      };
    }

    // If task is provided, keep it as task parameter for task ID lookup
    // Don't override session parameter - let domain layer handle task ID resolution
    if (params.task) {
      return {
        ...params,
        // Keep task as task parameter for proper task ID lookup
      };
    }

    // CLI auto-detection: extract session from working directory
    const currentDir = workingDir || process.cwd();

    if (currentDir.includes("/sessions/")) {
      const pathParts = currentDir.split("/");
      const sessionsIndex = pathParts.indexOf("sessions");

      if (sessionsIndex >= 0 && sessionsIndex < pathParts.length - 1) {
        const detectedSession = pathParts[sessionsIndex + 1];

        log.debug("CLI auto-detected session from working directory", {
          workingDir: currentDir,
          detectedSession,
        });

        return {
          ...params,
          session: detectedSession,
        };
      }
    }

    // No session could be resolved
    return params;
  }
}

/**
 * Interface adapter for MCP session context resolution
 * Requires explicit session parameter - no auto-detection
 */
export class MCPSessionContextResolver {
  /**
   * Resolve session context for MCP interface
   * Always requires explicit session parameter
   */
  static resolveSessionContext(params: any, workingDir?: string): any {
    // If session is explicitly provided via session or name parameter, use it
    if (params.session || params.name) {
      return {
        ...params,
        session: params.session || params.name,
      };
    }

    // If task is provided, keep it as task parameter for task ID lookup
    // Don't override session parameter - let domain layer handle task ID resolution
    if (params.task) {
      return {
        ...params,
        // Keep task as task parameter for proper task ID lookup
      };
    }

    // MCP interface: no auto-detection, session must be explicit
    throw new ValidationError(
      `Session parameter required for MCP interface.

Please provide one of:
  session: "task#158"     // Session name
  name: "task#158"        // Session name (alternative)
  task: "158"            // Task ID

Examples:
  session.pr({ session: "task#158", title: "Fix bug" })
  session.pr({ name: "task#158", title: "Fix bug" })
  session.pr({ task: "158", title: "Fix bug" })

💡 MCP tools don't auto-detect session context like CLI commands do.`
    );
  }
}

/**
 * Universal session context resolver factory
 * Returns the appropriate resolver based on interface type
 */
export class SessionContextResolverFactory {
  static getResolver(
    interfaceType: string
  ): typeof CLISessionContextResolver | typeof MCPSessionContextResolver {
    switch (interfaceType.toLowerCase()) {
      case "cli":
        return CLISessionContextResolver;
      case "mcp":
        return MCPSessionContextResolver;
      default:
        // Default to MCP behavior (require explicit session)
        return MCPSessionContextResolver;
    }
  }

  /**
   * Resolve session context based on interface type
   */
  static resolveSessionContext(params: any, interfaceType: string, workingDir?: string): any {
    const resolver = this.getResolver(interfaceType);
    return resolver.resolveSessionContext(params, workingDir);
  }
}

/**
 * Helper function for interface adapters to resolve session context
 */
export function resolveSessionForInterface(
  params: any,
  interfaceType: "cli" | "mcp",
  workingDir?: string
): any {
  try {
    const resolvedParams = SessionContextResolverFactory.resolveSessionContext(
      params,
      interfaceType,
      workingDir
    );

    // Validate that we ended up with a session
    if (!resolvedParams.session) {
      throw new ValidationError(
        `No session context available.

Interface: ${interfaceType}
Parameters: ${JSON.stringify(params, null, 2)}
Working Directory: ${workingDir || process.cwd()}

${
  interfaceType === "cli"
    ? "Try running this command from a session workspace, or provide --name <session>"
    : 'Provide session parameter: { session: "task#158" }'
}`
      );
    }

    return resolvedParams;
  } catch (error) {
    log.error("Session context resolution failed", {
      interfaceType,
      params,
      workingDir,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
