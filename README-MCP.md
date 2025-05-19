# Minsky MCP (Model Context Protocol) Server

Minsky includes support for the Model Context Protocol (MCP), which enables AI assistants and other tools to interact with Minsky programmatically. This document explains how to use the MCP server with Minsky.

## What is MCP?

The Model Context Protocol (MCP) is a standardized protocol for enabling AI assistants and other tools to interact with external systems. It provides a structured way for AI assistants to discover, invoke, and receive responses from command-line tools, APIs, and other services.

## Starting the MCP Server

To start the Minsky MCP server, use the `mcp start` command:

```bash
# Start the MCP server with default settings (stdio transport)
minsky mcp start

# Start with SSE transport on a specific port
minsky mcp start --sse --port 8080

# Start with HTTP streaming
minsky mcp start --http-stream --port 9000
```

## Transport Options

The Minsky MCP server supports multiple transport mechanisms:

- **stdio** (default): Standard input/output transport, suitable for direct process communication
- **SSE** (Server-Sent Events): For web-based communication over HTTP
- **HTTP Streaming**: For more efficient web-based communication with larger payloads

## Available Tools

The Minsky MCP server exposes the following tools:

### Task Management

- `tasks.list`: List all tasks
- `tasks.get`: Get details for a specific task
- `tasks.status.get`: Get the status of a task
- `tasks.status.set`: Set the status of a task
- `tasks.create`: Create a new task from a specification

### Session Management

- `session.list`: List all sessions
- `session.get`: Get details for a specific session
- `session.start`: Start a new session
  - Supports repository backend options (see below)
- `session.commit`: Commit changes in a session
- `session.push`: Push changes in a session

### Repository Backend Support

When using the `session.start` tool, you can specify different repository backends:

```json
{
  "name": "session.start",
  "params": {
    "name": "my-session",
    "backend": "github",
    "githubOwner": "octocat",
    "githubRepo": "hello-world",
    "githubToken": "ghp_xxxxxxxxxxxx"
  }
}
```

#### Backend Types

- `local` (default): For local filesystem repositories
- `remote`: For any remote Git repository URL
- `github`: Special handling for GitHub repositories with API integration

#### Backend-Specific Parameters

For `remote` backend:
- `repoUrl`: URL of the remote repository
- `authMethod`: Authentication method (`ssh`, `https`, or `token`)
- `cloneDepth`: Clone depth for shallow clones

For `github` backend:
- `githubOwner`: Owner/organization name
- `githubRepo`: Repository name
- `githubToken`: GitHub access token for authentication

## Usage Examples

### Using Minsky MCP with Claude

Here's an example of how to use the Minsky MCP server with Claude's MCP integration:

1. Start the Minsky MCP server:

   ```bash
   minsky mcp start
   ```

2. Add the following configuration to your Claude config file:

   ```json
   {
     "mcpServers": {
       "minsky": {
         "command": "minsky",
         "args": ["mcp", "start"]
       }
     }
   }
   ```

3. In Claude, you can now use Minsky commands:
   ```
   @minsky tasks.list
   ```

### Programmatic Usage with FastMCP Client

You can also connect to the Minsky MCP server programmatically using the FastMCP client:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";

async function connectToMinskyMCP() {
  // Create an MCP client
  const client = new Client(
    {
      name: "my-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    }
  );

  // Connect to Minsky MCP server via stdio
  const process = spawn("minsky", ["mcp", "start"]);
  const transport = new StdioClientTransport(process.stdin, process.stdout);
  await client.connect(transport);

  // Use the Minsky MCP tools
  const result = await client.executeTool({
    name: "tasks.list",
    params: {
      filter: "TODO",
      limit: 10,
    },
  });

  console.log("Tasks:", result);
}
```

## Security Considerations

- When using network-based transports (SSE or HTTP Streaming), be aware that this exposes Minsky commands to the network
- Consider using authentication mechanisms if exposing the MCP server on a network
- Only enable network transports in trusted environments

## Troubleshooting

If you experience issues with the MCP server:

1. Make sure Minsky is properly installed and accessible in your PATH
2. Check that the MCP server is running with the expected transport type
3. Verify that you're using the correct endpoint and port for network transports
4. Check the console output of the MCP server for error messages

## Future Enhancements

- Authentication support for secure access to the MCP server
- Full support for all Minsky commands (Git, Init, Rules, etc.)
- Resource endpoints for accessing Minsky data as resources
- Streaming support for long-running operations
