// THROWAWAY SPIKE SERVER for mt#1315 — DO NOT REGISTER IN PRODUCTION MCP CONFIG.
//
// Purpose: empirically map Claude Code's MCP signaling surface so we can understand
// how notifications/message, stdio transport-exit, and InitializeResult.instructions
// are rendered in the UI. See docs/mcp-signaling-spike-findings.md for findings.
//
// Run:
//   bun run scripts/spike-mcp-signals.ts --transport=stdio
//   bun run scripts/spike-mcp-signals.ts --transport=http [--port=39115]

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  SetLevelRequestSchema,
  type LoggingLevel,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as http from "http";

// ─── Sidecar log ──────────────────────────────────────────────────────────────

const LOG_PATH = "/tmp/spike-mcp-signals.log";
const logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });

function sidecarLog(direction: "recv" | "send", message: unknown): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), direction, message });
  logStream.write(`${entry}\n`);
}

// ─── Parse CLI args ───────────────────────────────────────────────────────────

function parseArgs(): { transport: "stdio" | "http"; port: number } {
  const args = process.argv.slice(2);
  let transport: "stdio" | "http" = "stdio";
  let port = 39115;

  for (const arg of args) {
    if (arg.startsWith("--transport=")) {
      const val = arg.slice("--transport=".length);
      if (val !== "stdio" && val !== "http") {
        console.error(`Unknown transport: ${val}. Use stdio or http.`);
        process.exit(1);
      }
      transport = val;
    } else if (arg.startsWith("--port=")) {
      port = parseInt(arg.slice("--port=".length), 10);
      if (isNaN(port)) {
        console.error("Invalid port number");
        process.exit(1);
      }
    }
  }

  return { transport, port };
}

// ─── Build Server ─────────────────────────────────────────────────────────────

const LOG_LEVELS: LoggingLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

function buildServer(): Server {
  const server = new Server(
    { name: "spike-mcp-signals", version: "0.0.1" },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
      // [SPIKE-MARKER-1315] This instructions string is deliberately recognizable
      // so we can grep for it in transcripts and UI surfaces. If you see this text
      // in the Claude Code UI (chat stream, server detail panel, hover tooltip),
      // that confirms InitializeResult.instructions is user-visible.
      instructions:
        "[SPIKE-MARKER-1315] This is the spike server for mt#1315. " +
        "If you can read this in any UI surface — chat stream, /mcp panel, hover text, " +
        "model context window — please note the exact location and format in " +
        "docs/mcp-signaling-spike-findings.md.",
    }
  );

  // ─── Intercept all outbound messages for sidecar logging ────────────────────
  // Patch the internal transport send after connect — see startServer() below.

  // ─── logging/setLevel handler ────────────────────────────────────────────────
  server.setRequestHandler(SetLevelRequestSchema, async (req) => {
    sidecarLog("recv", req);
    const level = req.params.level;
    console.error(`[spike] logging/setLevel received: ${level}`);
    return {};
  });

  // ─── tools/list ──────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    sidecarLog("recv", req);
    const result = {
      tools: [
        {
          name: "echo",
          description: "Echoes the input message back. Basic connectivity check.",
          inputSchema: {
            type: "object" as const,
            properties: {
              message: { type: "string", description: "The message to echo" },
            },
            required: ["message"],
          },
        },
        {
          name: "emit_log",
          description:
            "Emits a notifications/message at a controllable level, then returns success. " +
            "Use this to observe how Claude Code renders server log notifications at each severity.",
          inputSchema: {
            type: "object" as const,
            properties: {
              level: {
                type: "string",
                enum: LOG_LEVELS,
                description: "MCP logging level for the emitted notification",
              },
              text: {
                type: "string",
                description: "The text payload to include in the notification",
              },
            },
            required: ["level", "text"],
          },
        },
        {
          name: "exit_server",
          description:
            "Returns success, then exits the server process after a short delay. " +
            "Use this to observe what Claude Code shows when a stdio server exits cleanly.",
          inputSchema: {
            type: "object" as const,
            properties: {
              delayMs: {
                type: "number",
                description: "Milliseconds to wait before exit (default 250)",
              },
            },
            required: [],
          },
        },
      ],
    };
    sidecarLog("send", result);
    return result;
  });

  // ─── tools/call ──────────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    sidecarLog("recv", req);
    const { name, arguments: args } = req.params;

    if (name === "echo") {
      const message = (args as Record<string, unknown>)?.message ?? "(no message)";
      const result = {
        content: [{ type: "text" as const, text: `echo: ${message}` }],
      };
      sidecarLog("send", result);
      return result;
    }

    if (name === "emit_log") {
      const level = ((args as Record<string, unknown>)?.level ?? "info") as LoggingLevel;
      const text = (args as Record<string, unknown>)?.text ?? "(no text)";

      if (!LOG_LEVELS.includes(level)) {
        const errResult = {
          content: [
            {
              type: "text" as const,
              text: `Unknown level: ${level}. Valid levels: ${LOG_LEVELS.join(", ")}`,
            },
          ],
          isError: true,
        };
        sidecarLog("send", errResult);
        return errResult;
      }

      // Send the notifications/message notification
      const notification = {
        method: "notifications/message" as const,
        params: {
          level,
          logger: "spike",
          data: { text },
        },
      };

      try {
        await server.notification(notification);
        sidecarLog("send", notification);
      } catch (err) {
        console.error(`[spike] Failed to send notification: ${err}`);
      }

      const result = {
        content: [
          {
            type: "text" as const,
            text: `Sent notifications/message at level=${level} with text="${text}". Check the /mcp UI for any rendering.`,
          },
        ],
      };
      sidecarLog("send", result);
      return result;
    }

    if (name === "exit_server") {
      const delayMs = ((args as Record<string, unknown>)?.delayMs as number) ?? 250;

      const result = {
        content: [
          {
            type: "text" as const,
            text: `Server will exit in ${delayMs}ms. Observe what Claude Code shows in /mcp and on the next tool call.`,
          },
        ],
      };
      sidecarLog("send", result);

      // Schedule exit after response flushes
      setTimeout(() => {
        console.error("[spike] Exiting now (exit_server called)");
        sidecarLog("send", { event: "process.exit", delayMs });
        logStream.end(() => {
          process.exit(0);
        });
      }, delayMs);

      return result;
    }

    const unknownResult = {
      content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
    sidecarLog("send", unknownResult);
    return unknownResult;
  });

  return server;
}

// ─── Start: stdio ─────────────────────────────────────────────────────────────

async function startStdio(): Promise<void> {
  console.error(`[spike] Starting stdio transport. Sidecar log: ${LOG_PATH}`);

  const server = buildServer();
  const transport = new StdioServerTransport();

  // Intercept inbound messages for sidecar logging
  const origOnMessage = transport.onmessage;
  transport.onmessage = (msg) => {
    sidecarLog("recv", msg);
    origOnMessage?.(msg);
  };

  // Intercept outbound messages for sidecar logging by wrapping send
  const origSend = transport.send.bind(transport);
  transport.send = async (msg) => {
    sidecarLog("send", msg);
    return origSend(msg);
  };

  process.on("SIGINT", async () => {
    console.error("[spike] SIGINT received, closing...");
    await server.close();
    logStream.end(() => process.exit(0));
  });

  process.on("SIGTERM", async () => {
    console.error("[spike] SIGTERM received, closing...");
    await server.close();
    logStream.end(() => process.exit(0));
  });

  await server.connect(transport);
  console.error("[spike] stdio server connected and listening.");
}

// ─── Start: HTTP (Streamable HTTP) ───────────────────────────────────────────

async function startHttp(port: number): Promise<void> {
  const url = `http://localhost:${port}/mcp`;
  console.error(`[spike] Starting HTTP transport at ${url}`);
  console.log(`MCP server running at: ${url}`);

  const server = buildServer();

  // Stateless transport: each POST gets a fresh session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Intercept outbound messages for sidecar logging
  const origSend = transport.send.bind(transport);
  transport.send = async (msg) => {
    sidecarLog("send", msg);
    return origSend(msg);
  };

  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    sidecarLog("recv", { method: req.method, url: req.url });

    if (req.url === "/mcp" || req.url === "/mcp/") {
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found. Spike server endpoint is /mcp");
    }
  });

  process.on("SIGINT", async () => {
    console.error("[spike] SIGINT received, shutting down HTTP server...");
    httpServer.close();
    await server.close();
    logStream.end(() => process.exit(0));
  });

  process.on("SIGTERM", async () => {
    console.error("[spike] SIGTERM received, shutting down HTTP server...");
    httpServer.close();
    await server.close();
    logStream.end(() => process.exit(0));
  });

  httpServer.listen(port, "localhost", () => {
    console.error(`[spike] HTTP server listening on ${url}`);
  });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { transport, port } = parseArgs();

  sidecarLog("send", { event: "startup", transport, port, pid: process.pid });

  if (transport === "stdio") {
    await startStdio();
  } else {
    await startHttp(port);
  }
}

main().catch((err) => {
  console.error("[spike] Fatal error:", err);
  process.exit(1);
});
