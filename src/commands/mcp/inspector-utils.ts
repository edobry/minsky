import { spawn } from "child_process";
import { log } from "../../utils/logger";

/**
 * Enhanced error information from MCP inspector
 */
export interface McpInspectorError {
  type: "validation" | "timeout" | "execution" | "unknown";
  message: string;
  toolName?: string;
  missingParam?: string;
  availableParams?: string[];
  suggestion?: string;
}

/**
 * Parse MCP inspector output to extract meaningful error information
 */
export function parseInspectorError(output: string, toolName?: string): McpInspectorError {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Look for specific error patterns
  for (const line of lines) {
    // Missing required parameter
    if (line.includes("Missing required parameter:")) {
      const match = line.match(/Missing required parameter:\s*(\w+)/);
      const missingParam = match?.[1];
      return {
        type: "validation",
        message: `Missing required parameter: ${missingParam}`,
        toolName,
        missingParam,
        suggestion: missingParam
          ? `Use --arg ${missingParam}=<value>`
          : "Check the tool schema for required parameters",
      };
    }

    // Request timeout
    if (line.includes("Request timed out") || line.includes("timeout")) {
      return {
        type: "timeout",
        message: "Request timed out",
        toolName,
        suggestion: "The tool may be experiencing issues. Try again or use the CLI directly.",
      };
    }

    // Tool execution failed
    if (line.includes("Tool execution failed")) {
      return {
        type: "execution",
        message: "Tool execution failed",
        toolName,
        suggestion: "There may be an issue with the tool implementation.",
      };
    }
  }

  // Fallback for unknown errors
  return {
    type: "unknown",
    message: "Unknown error occurred",
    toolName,
    suggestion: `Try 'minsky mcp inspect --method tools/list' to see available tools`,
  };
}

/**
 * Execute the MCP inspector CLI with the given arguments
 * @param args Arguments to pass to the inspector CLI
 * @param options Execution options
 * @returns Promise that resolves with the output or rejects with enhanced error info
 */
export async function runInspectorCli(
  args: string[],
  options: {
    repo?: string;
    cwd?: string;
  } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Build the command to run the inspector CLI against our MCP server
    const serverArgs = ["mcp", "start"];
    if (options.repo) {
      serverArgs.push("--repo", options.repo);
    }

    const inspectorArgs = [
      "@modelcontextprotocol/inspector",
      "--cli",
      "minsky",
      ...serverArgs,
      ...args,
    ];

    log.debug("Running MCP inspector CLI", {
      command: "npx",
      args: inspectorArgs,
      cwd: options.cwd,
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    // Add timeout to prevent indefinite hanging
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill("SIGTERM");
        reject(new Error("MCP inspector CLI timed out after 30 seconds"));
      }
    }, 30000);

    const child = spawn("npx", inspectorArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd || process.cwd(),
      env: { ...process.env },
    });

    child.stdout?.on("data", (data) => {
      const output = data.toString();
      stdout += output;
      // Still show output for successful operations
      if (!output.includes("Failed") && !output.includes("error")) {
        process.stdout.write(output);
      }
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve();
      } else {
        // Parse the error output to provide better error messages
        const errorOutput = stderr || stdout;
        const toolNameMatch = args.find((arg) => args[args.indexOf(arg) - 1] === "--tool-name");
        const errorInfo = parseInspectorError(errorOutput, toolNameMatch);

        const enhancedError = new Error(errorInfo.message) as Error & {
          mcpError: McpInspectorError;
        };
        enhancedError.mcpError = errorInfo;
        reject(enhancedError);
      }
    });

    child.on("error", (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}
