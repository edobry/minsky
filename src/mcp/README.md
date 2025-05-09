# Minsky MCP Server

This directory contains the Model Context Protocol (MCP) implementation for Minsky. The MCP server allows AI agents to interact with Minsky commands in a structured way.

## Usage

### Starting the MCP Server

```bash
# Start with stdio transport (default)
minsky mcp start

# Start with SSE transport
minsky mcp start --sse --port 8080

# Start with HTTP Stream transport
minsky mcp start --http-stream --port 8080
```

### Authentication

The MCP server supports optional authentication:

```bash
# Start with authentication
minsky mcp start --auth --api-key your-secret-key
```

## Available Tools

The MCP server provides the following tools:

### Task Tools

- `tasks.list`: List all tasks
- `tasks.get`: Get a specific task by ID
- `tasks.status.get`: Get the status of a task
- `tasks.status.set`: Set the status of a task
- `tasks.create`: Create a new task from a specification document

### Session Tools

- `session.list`: List all sessions
- `session.get`: Get details of a specific session
- `session.start`: Start a new session
- `session.commit`: Commit changes in a session
- `session.push`: Push changes in a session

## Examples

### Connecting with FastMCP Client

```typescript
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";

// Create a client
const client = new Client(
  {
    name: "my-client",
    version: "1.0.0"
  },
  {
    capabilities: {}
  }
);

// Connect to a stdio-based server
const transport = new StdioClientTransport("minsky mcp start");
await client.connect(transport);

// List tasks
const result = await client.execute("tasks.list", {});
console.log(result);

// Get a specific task
const taskResult = await client.execute("tasks.get", { taskId: "001" });
console.log(taskResult);
```

### Connecting with SSE

```typescript
import { Client } from "@modelcontextprotocol/sdk/client";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse";

// Create a client
const client = new Client(
  {
    name: "my-client",
    version: "1.0.0"
  },
  {
    capabilities: {}
  }
);

// Connect to an SSE-based server
const transport = new SSEClientTransport(new URL("http://localhost:8080/sse"));
await client.connect(transport);

// Start a new session
const result = await client.execute("session.start", { task: "001" });
console.log(result);
```

## Architecture

The MCP implementation follows a modular design:

- `server.ts`: Core MCP server implementation
- `command-mapper.ts`: Maps Minsky CLI commands to MCP tools
- `tools/`: Directory containing tool implementations for different command groups
  - `tasks.ts`: Task-related tools
  - `session.ts`: Session-related tools

## Future Improvements

- Direct domain function calls instead of using `execSync`
- More comprehensive tests
- Additional tool implementations for Git, Rules, etc.
- Resource endpoints for data-focused operations
- Streaming for long-running operations 
