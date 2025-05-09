# minsky

A tool for coordinating AI agent workflows using Git and other collaboration tools, inspired by Marvin Minsky's "Society of Mind" theory and organizational cybernetics.

> **⚠️ Note:** This is an experimental project under active development. Not suitable for production use.

## Overview

Minsky helps AI agents collaborate on codebases by leveraging the same tools human engineers use:

- **Git repositories** for version control
- **Isolated workspaces** to prevent conflicts
- **Branch-based workflows** for parallel development
- **Pull request summaries** to document changes
- **Task management** for tracking and coordinating work items

The key idea is to enable agents to collaborate asynchronously using established software engineering practices, whether they're operating in the same environment or isolated from each other.

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/minsky.git
cd minsky

# Install dependencies
bun install

# Link globally
bun link
```

## Usage

### Git Commands

```bash
# Clone a repo (auto-generates session ID)
minsky git clone https://github.com/user/repo.git

# Clone with a named session
minsky git clone https://github.com/user/repo.git --session feature-x

# Create a branch in session
minsky git branch new-feature --session feature-x

# Generate PR document
minsky git pr --session feature-x
```

> **Note:** Most commands that operate on a repository support `--session <session>` (to use a named session's repo) or `--repo <repoPath>` (to specify a repo path directly).

### Session Commands

#### `minsky session start [options] [session-name]`

Start a new session with the given name. If no name is provided, a random one will be generated.

Options:
- `-r, --repo <repo-url>`: URL of the repository to clone (optional if in a git repository)
- `-t, --task <task-id>`: Task ID to associate with this session

#### `minsky session list [options]`

List all sessions.

Options:
- `--json`: Output in JSON format

#### `minsky session get [options] <session-name>`

Get details about a specific session.

Options:
- `--json`: Output in JSON format
- `--task <task-id>`: Get session by task ID

#### `minsky session delete [options] [session-name]`

Delete a session and its repository.

Options:
- `--force`: Skip confirmation prompt
- `--json`: Output in JSON format
- `--task <task-id>`: Delete session by task ID

#### `minsky session dir <session-name>`

Print the directory path for a session.

#### `minsky session update [options] [session-name]`

Update a session with the latest changes from the main branch. If no session name is provided, uses the current session.

Options:
- `--no-stash`: Skip stashing changes
- `--no-push`: Skip pushing changes to remote
- `--branch <branch>`: Branch to merge from (defaults to main)
- `--remote <remote>`: Remote to use (defaults to origin)

Example:
```bash
# Update current session with latest changes from main
minsky session update

# Update specific session with latest changes from develop branch
minsky session update my-session --branch develop

# Update session without stashing changes
minsky session update --no-stash

# Update session without pushing changes
minsky session update --no-push

# Update session using a different remote
minsky session update --remote upstream
```

### Tasks Management

Minsky supports robust, extensible task management with multiple backends (default: Markdown checklist in `process/tasks.md`).

```bash
# List all tasks in the current repo (or specify with --repo or --session)
minsky tasks list --repo /path/to/repo

# Filter tasks by status (TODO, DONE, IN-PROGRESS, IN-REVIEW)
minsky tasks list --repo /path/to/repo --status TODO

# Get details for a specific task by ID
minsky tasks get --repo /path/to/repo #001

# Get the status of a task
minsky tasks status get --repo /path/to/repo #001

# Set the status of a task (with explicit status)
minsky tasks status set --repo /path/to/repo #001 DONE

# Set the status of a task (interactive prompt)
minsky tasks status set --repo /path/to/repo #001
```

**Options:**
- `--repo <repoPath>`: Path to a git repository (overrides session)
- `--session <session>`: Session name to use for repo resolution
- `--backend <backend>`: Task backend to use (default: markdown, future: github)
- `--status <status>`: Filter tasks by status (for `list`)
- `--task <taskId>`: Task ID to associate with session (for `session start`)
- `--json`: Output tasks as JSON

**Features:**
- Parses Markdown checklists in `process/tasks.md`, skipping code blocks and malformed lines
- Aggregates indented lines as task descriptions
- Extensible: future support for GitHub Issues and other backends
- Supports task statuses: TODO, DONE, IN-PROGRESS (-), IN-REVIEW (+)
- Interactive status selection when no status is provided to `tasks status set`

## Task Workspace Detection

Minsky now automatically ensures that task operations are performed in the main workspace, even when executed from a session repository. This ensures that task status changes, creation, and querying all maintain consistency by operating on the main repository's task files.

### How It Works

1. When a task command is executed from a session repository, Minsky automatically detects this and resolves the main workspace path.
2. All task operations are performed on files in the main workspace rather than session-specific copies.
3. No manual directory change is required - the redirection is transparent.

### Command Line Options

All task commands now support a `--workspace <path>` option to explicitly specify the main workspace path:

```
minsky tasks list --workspace /path/to/main/workspace
minsky tasks get '#001' --workspace /path/to/main/workspace
minsky tasks status set '#001' DONE --workspace /path/to/main/workspace
```

This option overrides any automatic workspace detection. The previous `--repo` and `--session` options still work, but the workspace path takes precedence when provided.

## MCP (Model Context Protocol) Support

Minsky now supports the Model Context Protocol (MCP), which enables AI assistants and other tools to interact with Minsky programmatically. This allows for seamless integration with AI agents like Claude, GitHub Copilot, and others that support MCP.

```bash
# Start the MCP server with default settings (stdio transport)
minsky mcp start

# Start with SSE transport on a specific port
minsky mcp start --sse --port 8080
```

MCP allows AI agents to:
- Manage tasks and track their status
- Create and manage development sessions
- Perform git operations
- Initialize new projects with Minsky
- Access structured responses in a consistent format

For detailed documentation on using MCP with Minsky, see [README-MCP.md](./README-MCP.md).

## Example Workflows

### Basic Development Flow

```bash
# Start a new session
minsky session start feature-123 --repo https://github.com/org/project.git

# Get session directory
cd $(minsky session dir feature-123)

# Work on code, then generate PR
minsky git pr --session feature-123 > PR.md

# List and update tasks
minsky tasks list --session feature-123
minsky tasks status set --session feature-123 #001 DONE
```

### Multi-Agent Collaboration

Multiple agents can work on related features in parallel:

```bash
# Agent 1: Authentication backend
minsky session start auth-api --repo https://github.com/org/project.git

# Agent 2: Frontend integration
minsky session start auth-ui --repo https://github.com/org/project.git
```

Each agent works in its own isolated environment and can generate PR documents to share their changes. Tasks can be listed and updated per session or repo.

## Future Plans

- Team organization patterns for agents
- Session continuity and context management
- Automated code reviews
- Task planning and allocation (with more backends)

## Contributing

This project is a research experiment in non-human developer experience. Ideas, issues and PRs are welcome!

## License

MIT
