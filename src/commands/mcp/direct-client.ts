import { spawn } from "child_process";
import { log } from "@minsky/shared/logger";

/**
 * Parse repeated `--arg key=value` strings into the arguments object sent to the tool.
 *
 * Extracted as a pure function so the marshalling can be tested without spawning a
 * server (the pure-decision-core pattern, mt#3629): everything else in this module is IO.
 */
export function parseToolArgs(args: string[]): Record<string, string> {
  const argsObj: Record<string, string> = {};
  for (const arg of args) {
    // Split on the FIRST separator only, keeping the remainder in the value.
    // Do NOT use `arg.split("=", 2)`: JavaScript's limit caps the RESULT ARRAY
    // LENGTH and DISCARDS the rest, so `content=a=b=c` yielded `content -> "a"`
    // and the tool was called with a silently truncated value (mt#4459).
    const separatorIndex = arg.indexOf("=");
    // -1 is "no separator"; 0 is a leading separator, i.e. an empty key. Both are
    // malformed, and both are skipped rather than written under a bogus key.
    if (separatorIndex <= 0) continue;
    argsObj[arg.slice(0, separatorIndex)] = arg.slice(separatorIndex + 1);
  }
  return argsObj;
}

/**
 * Call an MCP tool directly via stdio (faster than inspector CLI)
 * @param toolName Name of the tool to call
 * @param args Tool arguments as key-value pairs
 * @param options Options for the call
 */
export async function callMcpToolDirectly(
  toolName: string,
  args: string[],
  options: { repo?: string; timeout?: number } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverArgs = ["mcp", "start"];
    if (options.repo) {
      serverArgs.push("--repo", options.repo);
    }

    log.debug(`Spawning minsky with args: ${JSON.stringify(serverArgs)}`);
    const child = spawn("minsky", serverArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    log.debug(`Child process spawned with PID: ${child.pid}`);

    // Configurable timeout for the operation
    // Use longer timeout for session operations
    const timeoutMs = options.timeout || (toolName.startsWith("session.") ? 60000 : 10000);
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        log.debug(`Killing child process ${child.pid} due to timeout`);
        child.kill("SIGTERM");
        reject(new Error(`Tool '${toolName}' timed out after ${timeoutMs / 1000} seconds`));
      }
    }, timeoutMs);

    // Convert args array to object
    const argsObj = parseToolArgs(args);

    // Send the MCP request
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: argsObj,
      },
    };

    // Wait a moment for the MCP server to start up
    setTimeout(() => {
      log.debug(`Sending MCP request: ${JSON.stringify(request)}`);
      child.stdin?.write(`${JSON.stringify(request)}\n`);
      child.stdin?.end();
    }, 1000);

    child.stdout?.on("data", (data) => {
      const output = data.toString();
      stdout += output;
      log.debug(`Received stdout: ${output.trim()}`);

      // Check if we got a complete JSON-RPC response and resolve early
      const lines = output.split("\n");
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('{"result":') || trimmedLine.startsWith('{"error":')) {
          try {
            const response = JSON.parse(trimmedLine);
            if (response.jsonrpc === "2.0" && response.id === 1 && !resolved) {
              resolved = true;
              clearTimeout(timeout);
              child.kill("SIGTERM");

              if (response.error) {
                reject(new Error(response.error.message || "MCP tool call failed"));
                return;
              }
              if (response.result !== undefined) {
                if (typeof response.result === "string") {
                  log.cli(String(response.result));
                } else {
                  log.cli(JSON.stringify(response.result, null, 2));
                }
                resolve();
                return;
              }
            }
          } catch (lineParseError) {
            // Continue processing
          }
        }
      }
    });

    child.stderr?.on("data", (data) => {
      const output = data.toString();
      stderr += output;
      log.debug(`Received stderr: ${output.trim()}`);
    });

    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);

      try {
        // Parse the server output to find the JSON-RPC response
        const lines = stdout.split("\n");
        for (const line of lines) {
          const trimmedLine = line.trim();

          // Look for JSON-RPC responses (might be direct or in debug logs)
          type JsonRpcResponse = {
            jsonrpc?: string;
            id?: number;
            result?: unknown;
            error?: { message?: string };
          };
          let jsonrpcResponse: JsonRpcResponse | null = null;

          // Try direct JSON-RPC response
          if (
            trimmedLine.startsWith('{"result":') ||
            trimmedLine.startsWith('{"error":') ||
            trimmedLine.includes('"jsonrpc"')
          ) {
            try {
              const response = JSON.parse(trimmedLine);
              if (response.jsonrpc === "2.0" && response.id === 1) {
                jsonrpcResponse = response;
              }
            } catch (lineParseError) {
              // Continue to check for embedded responses
            }
          }

          // If not found, look for JSON-RPC embedded in debug logs
          if (!jsonrpcResponse && trimmedLine.includes('"jsonrpc"')) {
            try {
              const debugLog = JSON.parse(trimmedLine);
              if (
                debugLog.message &&
                typeof debugLog.message === "string" &&
                debugLog.message.includes('"jsonrpc"')
              ) {
                const jsonStart = debugLog.message.indexOf("{");
                if (jsonStart !== -1) {
                  const jsonPart = debugLog.message.substring(jsonStart);
                  const response = JSON.parse(jsonPart);
                  if (response.jsonrpc === "2.0" && response.id === 1) {
                    jsonrpcResponse = response;
                  }
                }
              }
            } catch (lineParseError) {
              // Continue
            }
          }

          if (jsonrpcResponse) {
            if (jsonrpcResponse.error) {
              reject(new Error(jsonrpcResponse.error.message || "MCP tool call failed"));
              return;
            }
            if (jsonrpcResponse.result !== undefined) {
              // Pretty print the result
              if (typeof jsonrpcResponse.result === "string") {
                log.cli(String(jsonrpcResponse.result));
              } else {
                log.cli(JSON.stringify(jsonrpcResponse.result, null, 2));
              }
              resolve();
              return;
            }
          }
        }

        // If no valid JSON-RPC response found, check for any JSON-like lines
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith("{") && trimmedLine.includes("result")) {
            try {
              const response = JSON.parse(trimmedLine);
              if (response.result !== undefined) {
                if (typeof response.result === "string") {
                  log.cli(String(response.result));
                } else {
                  log.cli(JSON.stringify(response.result, null, 2));
                }
                resolve();
                return;
              }
            } catch (lineParseError) {
              continue;
            }
          }
        }

        log.debug(`Raw server output: ${stdout}`);
        log.debug(`Raw server stderr: ${stderr}`);
        reject(new Error("No valid MCP response found in server output"));
      } catch (parseError) {
        reject(new Error(`Failed to parse MCP response: ${parseError}`));
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
