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

# Start with the MCP inspector for debugging
minsky mcp start --with-inspector

# Start with the MCP inspector on a custom port
minsky mcp start --with-inspector --inspector-port 7000
```

## Transport Options

The Minsky MCP server supports multiple transport mechanisms:

- **stdio** (default): Standard input/output transport, suitable for direct process communication
- **SSE** (Server-Sent Events): For web-based communication over HTTP
- **HTTP Streaming**: For more efficient web-based communication with larger payloads

## Debugging with the MCP Inspector

The Minsky MCP server includes integration with the MCP Inspector, a tool that helps debug and visualize MCP interactions. This is particularly useful during development and testing.

### Using the Inspector

To start the MCP server with the inspector:

```bash
minsky mcp start --with-inspector
```

This will:
1. Start the MCP server normally
2. Launch the MCP Inspector on port 6274 (by default)
3. Open a browser window to the inspector interface

The inspector allows you to:
- View all tools available through the MCP server
- See request/response payloads for each tool invocation
- Test tool invocations directly through the UI
- Debug issues with tool parameters and responses

### Inspector Options

- `--with-inspector`: Enable the MCP Inspector
- `--inspector-port <port>`: Specify a custom port for the inspector (default: 6274)

### Requirements

The MCP Inspector requires the `@modelcontextprotocol/inspector` package. If it's not already installed, you can add it with:

```bash
bun add -d @modelcontextprotocol/inspector
```

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

### Git Operations

- `git.clone`: Clone a repository
  - Parameters: 
    - `url`: URL of the Git repository to clone (required)
    - `session`: Session identifier for the clone (optional)
    - `destination`: Target directory for the clone (optional)
    - `branch`: Branch to checkout after cloning (optional)

- `git.branch`: Create a branch in a repository
  - Parameters:
    - `session`: Session to create branch in (required)
    - `name`: Name of the branch to create (required)

- `git.commit`: Commit changes
  - Parameters:
    - `message`: Commit message (required)
    - `session`: Session to commit changes for (optional)
    - `repo`: Path to the repository (optional)
    - `amend`: Amend the previous commit (optional)
    - `all`: Stage all changes (optional)
    - `noStage`: Skip staging changes (optional)

- `git.push`: Push changes to a remote repository
  - Parameters:
    - `session`: Session to push changes for (optional)
    - `repo`: Path to the repository (optional)
    - `remote`: Remote to push to (defaults to origin) (optional)
    - `force`: Force push (use with caution) (optional)

- `git.pr`: Create a pull request
  - Parameters:
    - `session`: Session to create PR from (optional)
    - `repo`: Path to the repository (optional)
    - `branch`: Branch to create PR for (optional)
    - `taskId`: Task ID associated with this PR (optional)
    - `debug`: Enable debug logging (optional)
    - `noStatusUpdate`: Skip updating task status (optional)

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

### Rules Management

- `rules.list`: List all rules in the workspace
  - Parameters:
    - `format` (optional): Filter by rule format (cursor or generic)
    - `tag` (optional): Filter by tag
    - `debug` (optional): Show debug information

- `rules.get`: Get a specific rule by ID
  - Parameters:
    - `id`: Rule ID to retrieve
    - `format` (optional): Preferred rule format (cursor or generic)
    - `debug` (optional): Show debug information

- `rules.create`: Create a new rule
  - Parameters:
    - `id`: ID of the rule to create
    - `content` (optional): Content of the rule (or path to file containing content)
    - `description` (optional): Description of the rule
    - `name` (optional): Display name of the rule (defaults to ID)
    - `globs` (optional): Glob patterns to match files (comma-separated string or array)
    - `tags` (optional): Comma-separated list of tags for the rule
    - `format` (optional): Format of the rule file (defaults to 'cursor')
    - `overwrite` (optional): Overwrite existing rule if it exists

- `rules.update`: Update an existing rule
  - Parameters:
    - `id`: ID of the rule to update
    - `content` (optional): New content of the rule (or path to file containing content)
    - `description` (optional): New description of the rule
    - `name` (optional): New display name of the rule
    - `globs` (optional): New glob patterns to match files
    - `tags` (optional): New comma-separated list of tags for the rule
    - `format` (optional): New format of the rule file

- `rules.search`: Search for rules by content
  - Parameters:
    - `query`: Search query
    - `format` (optional): Filter by rule format (cursor or generic)
    - `tag` (optional): Filter by tag
    - `debug` (optional): Show debug information

### Initialization

- `init`: Initialize a project for Minsky
  - Parameters:
    - `repoPath` (optional): Repository path (defaults to current directory)
    - `backend` (optional): Task backend type (tasks.md or tasks.csv)
    - `ruleFormat` (optional): Rule format (cursor or generic)
    - `mcp` (optional): MCP configuration options
      - `enabled` (optional): Enable MCP configuration
      - `transport` (optional): MCP transport type (stdio, sse, httpStream)
      - `port` (optional): Port for MCP network transports
      - `host` (optional): Host for MCP network transports
    - `mcpOnly` (optional): Only configure MCP, skip other initialization steps
    - `overwrite` (optional): Overwrite existing files

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

## Task Command Reference

### tasks.list

Lists all tasks with basic filtering options.

**Parameters**:
- `filter` (optional): Filter tasks by status
- `all` (optional): Include completed tasks (default: false)
- `backend` (optional): Task backend to use (markdown, github)

**Example**:
```json
{
  "name": "tasks.list",
  "params": {
    "filter": "IN-PROGRESS",
    "all": false
  }
}
```

### tasks.get

Get details for a specific task by ID.

**Parameters**:
- `taskId`: ID of the task to retrieve
- `backend` (optional): Task backend to use (markdown, github)

**Example**:
```json
{
  "name": "tasks.get",
  "params": {
    "taskId": "052"
  }
}
```

### tasks.status.get

Get the status of a specific task.

**Parameters**:
- `taskId`: ID of the task
- `backend` (optional): Task backend to use (markdown, github)

**Example**:
```json
{
  "name": "tasks.status.get",
  "params": {
    "taskId": "052"
  }
}
```

### tasks.status.set

Set the status of a specific task.

**Parameters**:
- `taskId`: ID of the task
- `status`: New status for the task (TODO, IN-PROGRESS, IN-REVIEW, DONE)
- `backend` (optional): Task backend to use (markdown, github)

**Example**:
```json
{
  "name": "tasks.status.set",
  "params": {
    "taskId": "052",
    "status": "IN-PROGRESS"
  }
}
```

### tasks.create

Create a new task from a specification file.

**Parameters**:
- `specPath`: Path to the task specification file
- `force` (optional): Force creation even if task already exists (default: false)
- `backend` (optional): Task backend to use (markdown, github)

**Example**:
```json
{
  "name": "tasks.create",
  "params": {
    "specPath": "process/tasks/new-task-spec.md",
    "force": false
  }
}
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
