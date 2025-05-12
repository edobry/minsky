import { Command } from "commander";
import { resolveRepoPath, type RepoResolutionOptions } from "../../utils/repo";
import { initializeProject } from "../../domain/index";
import { exit } from "../../utils/process";
import * as p from "@clack/prompts";
import fs from "fs";
import path from "path";

export function createInitCommand(): Command {
  return new Command("init")
    .description("Initialize a project for Minsky")
    .option("-r, --repo <path>", "Repository path (defaults to current directory)")
    .option("-s, --session <n>", "Session name to get repo path from")
    .option("-b, --backend <type>", "Task backend type (tasks.md or tasks.csv)")
    .option("-f, --rule-format <format>", "Rule format (cursor or generic)")
    .option("--mcp <boolean>", "Enable/disable MCP configuration (default: true)")
    .option("--mcp-transport <type>", "MCP transport type (stdio, sse, httpStream)")
    .option("--mcp-port <port>", "Port for MCP network transports")
    .option("--mcp-host <host>", "Host for MCP network transports")
    .option("--mcp-only", "Only configure MCP, skip other initialization steps")
    .option("--overwrite", "Overwrite existing files")
    .action(
      async (options: {
        repo?: string;
        session?: string;
        backend?: string;
        ruleFormat?: string;
        mcp?: string;
        mcpTransport?: string;
        mcpPort?: string;
        mcpHost?: string;
        mcpOnly?: boolean;
        overwrite?: boolean;
      }) => {
        try {
          p.intro("Initialize Minsky in your project");

          // Resolve repo path
          let repoPath: string;
          try {
            repoPath = await resolveRepoPath({
              repo: options.repo,
              session: options.session,
            });
          } catch (error) {
            console.error(
              "Error resolving repository path:",
              error instanceof Error ? error.message : String(error)
            );
            exit(1);
          }

          // MCP-only mode doesn't need most of the interactive prompts
          let backend = options.backend || "tasks.md";
          let ruleFormat = options.ruleFormat || "cursor";

          // Only need interactive prompts if not in MCP-only mode
          if (!options.mcpOnly) {
            // If repo path was resolved without explicit flags, confirm with user
            if (!options.repo && !options.session) {
              const confirm = await p.confirm({
                message: `Using current directory: ${repoPath}\nContinue?`,
                initialValue: true,
              });

              if (p.isCancel(confirm) || !confirm) {
                p.cancel("Operation cancelled");
                exit(0);
              }
            }

            // Get backend type if not provided
            if (!backend) {
              const backendChoice = await p.select({
                message: "Choose a task backend",
                options: [
                  { value: "tasks.md", label: "tasks.md - Markdown-based task tracking" },
                  {
                    value: "tasks.csv",
                    label: "tasks.csv - CSV-based task tracking (not implemented yet)",
                  },
                ],
              });

              if (p.isCancel(backendChoice)) {
                p.cancel("Operation cancelled");
                exit(0);
              }

              backend = String(backendChoice);
            }

            // Get rule format if not provided
            if (!ruleFormat) {
              const formatChoice = await p.select({
                message: "Choose a rule format",
                options: [
                  { value: "cursor", label: "cursor - Store rules in .cursor/rules" },
                  { value: "generic", label: "generic - Store rules in .ai/rules" },
                ],
              });

              if (p.isCancel(formatChoice)) {
                p.cancel("Operation cancelled");
                exit(0);
              }

              ruleFormat = String(formatChoice);
            }
          }

          // Handle MCP configuration options
          let mcpEnabled = options.mcp !== "false"; // Default to true unless explicitly disabled
          let mcpTransport = options.mcpTransport;
          let mcpPort = options.mcpPort ? parseInt(options.mcpPort, 10) : undefined;
          let mcpHost = options.mcpHost;

          // Interactive MCP configuration if not provided via options
          if (options.mcp === undefined) {
            const mcpEnabledChoice = await p.confirm({
              message: options.mcpOnly
                ? "Configure MCP (Model Context Protocol) server?"
                : "Enable MCP (Model Context Protocol) server configuration?",
              initialValue: true,
            });

            if (p.isCancel(mcpEnabledChoice)) {
              p.cancel("Operation cancelled");
              exit(0);
            }

            mcpEnabled = mcpEnabledChoice;
          }

          // Only prompt for additional MCP options if MCP is enabled
          if (mcpEnabled) {
            // Get MCP transport if not provided
            if (!mcpTransport) {
              const transportChoice = await p.select({
                message: "Choose an MCP transport type",
                options: [
                  { value: "stdio", label: "stdio - Local machine only (default, most secure)" },
                  { value: "sse", label: "sse - Server-Sent Events (for network access)" },
                  {
                    value: "httpStream",
                    label: "httpStream - HTTP streaming (for network access)",
                  },
                ],
              });

              if (p.isCancel(transportChoice)) {
                p.cancel("Operation cancelled");
                exit(0);
              }

              mcpTransport = String(transportChoice);
            }

            // Only prompt for network settings if using a network transport
            if (mcpTransport === "sse" || mcpTransport === "httpStream") {
              // Get port if not provided and using network transport
              if (!mcpPort) {
                const portText = await p.text({
                  message: "Enter port for MCP server",
                  initialValue: "8080",
                  validate(value) {
                    const port = parseInt(value, 10);
                    if (isNaN(port) || port < 1 || port > 65535) {
                      return "Please enter a valid port number (1-65535)";
                    }
                  },
                });

                if (p.isCancel(portText)) {
                  p.cancel("Operation cancelled");
                  exit(0);
                }

                mcpPort = parseInt(String(portText), 10);
              }

              // Get host if not provided and using network transport
              if (!mcpHost) {
                const hostText = await p.text({
                  message: "Enter host for MCP server",
                  initialValue: "localhost",
                });

                if (p.isCancel(hostText)) {
                  p.cancel("Operation cancelled");
                  exit(0);
                }

                mcpHost = String(hostText);
              }
            }
          }

          // Init project
          await initializeProject({
            repoPath,
            backend: backend as "tasks.md" | "tasks.csv",
            ruleFormat: ruleFormat as "cursor" | "generic",
            mcp: mcpEnabled
              ? {
                  enabled: mcpEnabled,
                  transport: (mcpTransport as "stdio" | "sse" | "httpStream") || "stdio",
                  port: mcpPort,
                  host: mcpHost,
                }
              : { enabled: false, transport: "stdio" },
            mcpOnly: options.mcpOnly,
            overwrite: options.overwrite,
          });

          if (options.mcpOnly) {
            p.outro("MCP configuration added successfully!");
          } else {
            p.outro("Project initialized successfully!");
          }
        } catch (error) {
          console.error(
            "Error initializing project:",
            error instanceof Error ? error.message : String(error)
          );
          exit(1);
        }
      }
    );
}
