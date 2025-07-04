# minsky

[![CI](https://github.com/edobry/minsky/actions/workflows/ci.yml/badge.svg)](https://github.com/edobry/minsky/actions/workflows/ci.yml)
[![Code Style: Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)

> **⚠️ Note:** This is an experimental project under active development. Not suitable for production use.

## Overview

Minsky helps AI agents collaborate on codebases by leveraging the same tools human engineers use:

- **Git repositories** for version control
- **Isolated workspaces** to prevent conflicts
- **Branch-based workflows** for parallel development
- **Pull request summaries** to document changes
- **Task management** for tracking and coordinating work items

The key idea is to enable agents to collaborate asynchronously using established software engineering practices, whether they're operating in the same environment or isolated from each other.

## Core Concepts

Minsky operates around three key concepts:

### Repository

A **Repository** is a Git repository identified by an upstream URI. From Minsky's perspective, upstream repositories are considered read-only sources of truth.

### Session

A **Session** is a persistent workstream with metadata and an associated workspace. It represents a unit of work, typically tied to a specific task.

### Workspace

A **Workspace** is the filesystem location where a session's working copy exists. It is the physical manifestation of a session on disk.

These concepts form a clear relationship:

- Each **Session** is associated with exactly one upstream **Repository**
- Each **Session** has exactly one **Workspace**
- A **Repository** can be referenced by multiple **Sessions**

For detailed documentation on Minsky concepts and their relationships, see [src/domain/concepts.md](./src/domain/concepts.md).

> 📚 **Complete Documentation**: For comprehensive guides, examples, and detailed documentation, see [docs/README.md](./docs/README.md)

## Installation

### Prerequisites

- [Bun](https://bun.sh) runtime (recommended) or Node.js 18+
- Git (for repository management)
- TypeScript 5.0+ (peer dependency)
- **Optional**: SQLite or PostgreSQL for advanced SessionDB backends

### Quick Start

```bash
# Clone the repository
git clone https://github.com/edobry/minsky.git
cd minsky

# Install dependencies
bun install

# Run directly (for testing)
bun run src/cli.ts --help

# Link globally for system-wide usage
bun link
```

### Development Setup

For development and contributing:

```bash
# Clone and setup
git clone https://github.com/edobry/minsky.git
cd minsky
bun install

# Run tests
bun test

# Run linting
bun run lint

# Format code
bun run format

# Watch tests during development
bun run test:watch
```

### Using with Node.js

If you prefer Node.js over Bun:

```bash
# Install dependencies with npm/yarn
npm install

# Run with Node.js
node src/cli.ts --help

# Or compile TypeScript first
npx tsc
node dist/cli.js --help
```

### Verification

After installation, verify everything works:

```bash
# Check installation
minsky --version

# Initialize a test project
mkdir test-minsky && cd test-minsky
minsky init

# Start a test session (requires task association)
minsky session start --description "Test session setup"
```

## Configuration

### SessionDB Storage Backends

Minsky supports multiple storage backends for session data:

#### JSON File (Default)

Simple file-based storage, ideal for individual development:

```toml
# ~/.config/minsky/config.toml
[sessiondb]
backend = "json"
dbPath = "~/.local/state/minsky/session-db.json"
baseDir = "~/.local/state/minsky/git"
```

#### SQLite Database

Local database with ACID transactions, better for performance:

```toml
# ~/.config/minsky/config.toml
[sessiondb]
backend = "sqlite"
dbPath = "~/.local/state/minsky/sessions.db"
baseDir = "~/.local/state/minsky/git"
```

#### PostgreSQL Database

Server-based database for team environments:

```toml
# .minsky/config.toml (repository-level)
[sessiondb]
backend = "postgres"
connectionString = "postgresql://user:password@localhost:5432/minsky"
baseDir = "/shared/minsky/git"
```

#### Environment Variables

You can also configure backends using environment variables:

```bash
# Set backend type
export MINSKY_SESSION_BACKEND=sqlite

# Set SQLite database path
export MINSKY_SQLITE_PATH=~/.local/state/minsky/sessions.db

# Set PostgreSQL connection string
export MINSKY_POSTGRES_URL="postgresql://user:password@localhost:5432/minsky"

# Set base directory for session workspaces
export MINSKY_SESSIONDB_BASE_DIR=~/.local/state/minsky/git
```

### Migration Between Backends

Use the built-in migration tools to switch between backends:

```bash
# Migrate from JSON to SQLite
minsky sessiondb migrate to sqlite --backup ./backups

# Migrate to PostgreSQL
minsky sessiondb migrate to postgres \
  --connection-string "postgresql://user:password@localhost:5432/minsky" \
  --backup ./backups

# Check current backend status
minsky sessiondb migrate status
```

For detailed migration guides, see [docs/sessiondb-migration-guide.md](./docs/sessiondb-migration-guide.md).

## Usage

### Session Commands

#### `minsky session start [options] [session-name]`

Start a new session with the given name. If no name is provided, a random one will be generated.

**REQUIRED**: Either `--task` or `--description` must be provided for task association.

Options:

- `-r, --repo <repo-url>`: URL of the repository to clone (optional if in a git repository)
- `-t, --task <task-id>`: Task ID to associate with this session (required if --description not provided)
- `-d, --description <text>`: Description for auto-created task (required if --task not provided)
- `--backend <type>`: Repository backend type (local, remote, github)
- `--repo-url <url>`: Remote repository URL for remote/github backends
- `--auth-method <method>`: Authentication method (ssh, https, token)
- `--clone-depth <depth>`: Clone depth for remote repositories
- `--github-token <token>`: GitHub access token for authentication
- `--github-owner <owner>`: GitHub repository owner/organization
- `--github-repo <repo>`: GitHub repository name

Examples:

```bash
# Start a session with existing task
minsky session start --task 123

# Start a session with auto-created task (session name auto-generated from task ID)
minsky session start --description "Implement user authentication"

# Start a session with custom name and existing task
minsky session start my-session --task 456
```

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

### Git Commands

```bash
# Clone a repo (auto-generates session ID)
minsky git clone https://github.com/user/repo.git

# Clone with a named session
minsky git clone https://github.com/user/repo.git --session feature-x

# Create a branch in session
minsky git branch new-feature --session feature-x

# Generate PR summary
minsky git summary --session feature-x
```

> **Note:** Most commands that operate on a repository support `--session <session>` (to use a named session's repo) or `--repo <repoPath>` (to specify a repo path directly).

### PR Workflow Commands

Minsky provides an enhanced pull request workflow with prepared merge commits:

#### `minsky session pr [session-name] [options]`

Creates a PR branch for a session with a pre-created merge commit that is ready for fast-forward merge.

Options:

- `--task <taskId>`: Task ID to match (if not providing session name)
- `--title <title>`: PR title (if not provided, will be generated)
- `--body <body>`: PR body (if not provided, will be generated)
- `--base-branch <branch>`: Base branch for PR (defaults to main)
- `--debug`: Enable debug output
- `--no-status-update`: Skip updating task status

#### `minsky git prepare-pr [options]`

Creates a PR branch with a pre-created merge commit that is ready for fast-forward merge.

Options:

- `--repo <path>`: Path to the repository
- `--base-branch <branch>`: Base branch for PR (defaults to main)
- `--title <title>`: PR title (if not provided, will be generated)
- `--body <body>`: PR body (if not provided, will be generated)
- `--debug`: Enable debug output
- `--session <session>`: Session to create PR for

#### `minsky session approve [options]`

Approves and merges a session's PR branch, updating the task status to DONE.

Options:

- `--session <session>`: Name of the session to approve
- `--task <taskId>`: Task ID associated with the session
- `--repo <path>`: Repository path

For detailed documentation on the PR workflow, see [docs/pr-workflow.md](./docs/pr-workflow.md).

### Task Management

Minsky supports robust, extensible task management with multiple backends.

#### Available Backends

1. **Markdown Backend (default)**: Traditional checklist in `process/tasks.md`
2. **JSON File Backend**: Centralized JSON database for enhanced synchronization
3. **GitHub Issues Backend**: Manage tasks as GitHub Issues with full API integration

#### Basic Usage

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

#### Backend-Specific Usage

```bash
# Use specific backend explicitly
minsky tasks list --backend markdown       # Traditional tasks.md
minsky tasks list --backend json-file      # Centralized JSON database
minsky tasks list --backend github-issues  # GitHub Issues integration

# JSON backend provides enhanced synchronization across sessions
minsky tasks status set #001 DONE --backend json-file

# GitHub backend integrates with GitHub Issues API
export GITHUB_TOKEN=ghp_xxxxxxxxxxxx
minsky tasks list --backend github-issues
```

#### JSON Task Backend

The JSON Task Backend offers several advantages over the traditional markdown approach:

- **Cross-Session Synchronization**: Changes visible across all sessions immediately
- **Enhanced Performance**: Faster querying and filtering for large task sets
- **Future-Proof Architecture**: Easy migration path to SQL databases
- **Type Safety**: Full TypeScript support with validation
- **Centralized Storage**: Single source of truth stored in user data directory

**Migration**: For projects wanting to migrate from markdown to JSON backend, see [docs/JSON-TASK-BACKEND-MIGRATION.md](./docs/JSON-TASK-BACKEND-MIGRATION.md) for a comprehensive migration guide.

**Architecture**: For technical details about the JSON backend implementation, see [docs/JSON-TASK-BACKEND.md](./docs/JSON-TASK-BACKEND.md).

#### GitHub Issues Task Backend

The GitHub Issues backend integrates Minsky tasks with GitHub's issue tracking system:

- **API Integration**: Full GitHub REST API integration with authentication
- **Status Mapping**: Maps Minsky statuses to GitHub issue states and labels
- **Bidirectional Sync**: Create, update, and track tasks as GitHub issues
- **Label Management**: Automatic creation and management of status labels
- **Repository Integration**: Works with both public and private repositories

**Configuration**: The GitHub backend requires authentication via the `GITHUB_TOKEN` environment variable and repository information through command options or configuration.

**Options:**

- `--repo <repoPath>`: Path to a git repository (overrides session)
- `--session <session>`: Session name to use for repo resolution
- `--backend <backend>`: Task backend to use (markdown, json-file, github-issues)
- `--status <status>`: Filter tasks by status (for `list`)
- `--task <taskId>`: Task ID to associate with session (for `session start`)
- `--json`: Output tasks as JSON

**Features:**

- Parses Markdown checklists in `process/tasks.md`, skipping code blocks and malformed lines
- Aggregates indented lines as task descriptions
- Extensible: supports multiple backends (markdown, json-file, github-issues)
- Supports task statuses: TODO, DONE, IN-PROGRESS (-), IN-REVIEW (+)
- Interactive status selection when no status is provided to `tasks status set`
- Cross-session synchronization with JSON and GitHub backends

### Environment-Aware Logging

Minsky features an environment-aware logging system that adjusts its output based on the execution context:

- **HUMAN Mode** (default for terminal usage):

  - Outputs clean, human-readable logs only
  - Suppresses verbose JSON output for better terminal experience
  - Can be forced with `MINSKY_LOG_MODE=HUMAN`

- **STRUCTURED Mode** (for automation, CI/CD):
  - Outputs detailed structured JSON logs for machine consumption
  - Includes both JSON and minimal human-readable feedback
  - Can be forced with `MINSKY_LOG_MODE=STRUCTURED`

You can also set `ENABLE_AGENT_LOGS=true` to enable JSON logs in HUMAN mode if needed.

For more detailed documentation on logging, see [docs/logging.md](./docs/logging.md).

### Task Workspace Detection

Minsky automatically ensures that task operations are performed in the main workspace, even when executed from a session repository. This ensures that task status changes, creation, and querying all maintain consistency by operating on the main repository's task files.

#### How It Works

1. When a task command is executed from a session repository, Minsky automatically detects this and resolves the main workspace path.
2. All task operations are performed on files in the main workspace rather than session-specific copies.
3. No manual directory change is required - the redirection is transparent.

#### Command Line Options

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

### Rules Management

Minsky includes a comprehensive rules management system for storing and organizing project-specific rules, guidelines, and documentation.

#### `minsky rules list [options]`

List all available rules.

Options:

- `--format <format>`: Preferred rule format (cursor, generic)
- `--tag <tag>`: Filter rules by tag
- `--json`: Output in JSON format
- `--debug`: Enable debug output

#### `minsky rules get <id> [options]`

Get a specific rule by ID.

Options:

- `--format <format>`: Preferred rule format (cursor, generic)
- `--json`: Output in JSON format
- `--debug`: Enable debug output

#### `minsky rules create <id> [options]`

Create a new rule.

Options:

- `--content <content>`: Rule content (markdown/text)
- `--description <description>`: Rule description
- `--name <name>`: Human-readable rule name
- `--globs <patterns>`: Comma-separated glob patterns for file matching
- `--tags <tags>`: Comma-separated tags
- `--format <format>`: Rule format (cursor, generic)
- `--overwrite`: Overwrite existing rule
- `--json`: Output in JSON format

#### `minsky rules update <id> [options]`

Update an existing rule.

Options: Same as create, but all content options are optional.

#### `minsky rules search [options]`

Search rules by content or metadata.

Options:

- `--query <query>`: Search query term
- `--format <format>`: Preferred rule format
- `--tag <tag>`: Filter by tag
- `--json`: Output in JSON format

#### `minsky rules delete <id> [options]`

Delete a rule.

Options:

- `--json`: Output in JSON format
- `--force`: Skip confirmation prompt

Examples:

```bash
# List all rules
minsky rules list

# Create a new coding standard rule
minsky rules create coding-style \
  --content "Use TypeScript strict mode and prefer const over let" \
  --tags "typescript,style" \
  --description "TypeScript coding standards"

# Get a specific rule
minsky rules get coding-style

# Search for rules about testing
minsky rules search --query "testing"
```

### Configuration Management

Minsky provides configuration management to customize behavior across different projects and environments.

#### `minsky config list [options]`

Show all configuration from all sources (defaults, project config, environment variables).

Options:

- `--repo <path>`: Repository path
- `--workspace <path>`: Workspace path
- `--json`: Output in JSON format

#### `minsky config show [options]`

Show the final resolved configuration after merging all sources.

Options:

- `--repo <path>`: Repository path
- `--workspace <path>`: Workspace path
- `--json`: Output in JSON format

Examples:

```bash
# Show all configuration sources
minsky config list

# Show final resolved configuration
minsky config show

# Show config for specific workspace
minsky config show --workspace /path/to/project
```

### Project Initialization

#### `minsky init [options]`

Initialize a project for Minsky usage, setting up necessary files and configuration.

Options:

- `--repo <path>`: Repository path to initialize
- `--session <session>`: Session identifier
- `--backend <type>`: Task backend type (markdown, json-file, github-issues)
- `--github-owner <owner>`: GitHub repository owner (for github-issues backend)
- `--github-repo <repo>`: GitHub repository name (for github-issues backend)
- `--rule-format <format>`: Rule format (cursor, generic)
- `--mcp <enabled>`: Enable/disable MCP configuration (default: true)
- `--mcp-transport <transport>`: MCP transport type (stdio, sse, httpStream)
- `--mcp-port <port>`: Port for MCP network transports
- `--mcp-host <host>`: Host for MCP network transports
- `--mcp-only`: Only configure MCP, skip other initialization steps
- `--overwrite`: Overwrite existing files
- `--workspace <path>`: Workspace path

Examples:

```bash
# Initialize current directory
minsky init

# Initialize with GitHub Issues backend
minsky init --backend github-issues \
  --github-owner myorg --github-repo myproject

# Initialize with MCP configuration only
minsky init --mcp-only --mcp-transport sse --mcp-port 3000

# Initialize specific directory
minsky init --workspace /path/to/project --overwrite
```

## Repository Backend Support

Minsky supports multiple repository backends, allowing you to work with different sources of Git repositories:

### Available Backends

1. **Local Git (default)** - For local filesystem repositories
2. **Remote Git** - For any remote Git repository URL
3. **GitHub** - Special handling for GitHub repositories with API integration

### Using Repository Backends

When starting a session, you can specify the backend type and related options:

```bash
# Start a session with a local repository (default)
minsky session start my-session --repo /path/to/local/repo

# Start a session with a remote Git repository
minsky session start my-session --backend remote --repo-url https://gitlab.com/group/project.git

# Start a session with GitHub repository
minsky session start my-session --backend github --github-owner octocat --github-repo hello-world
```

### Backend-specific Options

#### Common Options

- `--backend <type>` - Repository backend type (local, remote, github)
- `--repo-url <url>` - Remote repository URL for remote/github backends

#### Remote Git Options

- `--auth-method <method>` - Authentication method (ssh, https, token)
- `--clone-depth <depth>` - Clone depth for remote repositories

#### GitHub Options

- `--github-token <token>` - GitHub access token for authentication
- `--github-owner <owner>` - GitHub repository owner/organization
- `--github-repo <repo>` - GitHub repository name

### Examples

```bash
# Start a session with a GitHub repository using token authentication
minsky session start github-project --backend github \
  --github-owner microsoft --github-repo vscode \
  --github-token ghp_xxxxxxxxxxxx

# Start a session with a remote Git repository using SSH authentication
minsky session start remote-project --backend remote \
  --repo-url git@gitlab.com:group/project.git \
  --auth-method ssh

# Start a session with a remote Git repository with shallow clone
minsky session start shallow-clone --backend remote \
  --repo-url https://bitbucket.org/user/repo.git \
  --clone-depth 1
```

## Example Workflows

### Basic Development Flow

```bash
# Start a new session (requires task association)
minsky session start --task 123 feature-session
# OR create new task automatically (session name auto-generated)
minsky session start --description "Implement user authentication"

# Get session directory
cd $(minsky session dir feature-session)

# Work on code, then generate PR
minsky session pr > PR.md

# List and update tasks
minsky tasks list --session feature-session
minsky tasks status set --session feature-session #001 DONE
```

### Multi-Agent Collaboration

Multiple agents can work on related features in parallel:

```bash
# Agent 1: Authentication backend
minsky session start --task 124 auth-api

# Agent 2: Frontend integration
minsky session start --task 125 auth-ui

# OR create tasks automatically (session names auto-generated)
minsky session start --description "Implement OAuth backend"
minsky session start --description "Add login UI components"
```

Each agent works in its own isolated environment and can generate PR documents to share their changes. Tasks can be listed and updated per session or repo.

### Remote Repository Workflow

```bash
# Start a session with a GitHub repository (requires task association)
minsky session start --task 126 github-feature --backend github \
  --github-owner octocat --github-repo hello-world

# OR create task automatically (session name auto-generated from task ID)
minsky session start --description "Add GitHub integration" \
  --backend github --github-owner octocat --github-repo hello-world

# Work in the session
cd $(minsky session dir github-feature)

# Make changes, then push to GitHub
git add .
git commit -m "Add new feature"
minsky git push

# Generate PR document
minsky git summary > PR.md
```

## Future Plans

- Team organization patterns for agents
- Session continuity and context management
- Automated code reviews
- Task planning and allocation (with more backends)

## Contributing

This project is a research experiment in non-human developer experience. Ideas, issues and PRs are welcome!

## Linting and Pre-commit Hooks

This project uses ESLint for identifying and reporting on patterns in JavaScript and TypeScript code, and Prettier for code formatting. To help maintain code quality and consistency, these tools are configured to run automatically before commits using Husky and lint-staged.

### Pre-commit Behavior

When you make a commit:

1.  **ESLint (`eslint --fix`)**: Automatically fixes fixable linting issues in staged `.ts` and `.js` files.
    - **Important Note**: If ESLint encounters errors it cannot automatically fix, it will still allow the commit to proceed. The autofixed changes will be part of the commit, but any remaining non-autofixable lint errors will persist. These should be addressed manually or will be caught by more stringent checks in the CI pipeline.
2.  **Prettier (`prettier --write`)**: Automatically formats staged `.ts`, `.js`, `.json`, and `.md` files.

This setup ensures that common formatting and simple lint issues are handled automatically without strictly blocking commits for all lint errors. However, developers are encouraged to run `bun run lint` manually to check for and resolve any outstanding lint issues before pushing.

The pre-commit hooks themselves (e.g., `.husky/pre-commit`) need to be active (i.e., not have a `.disabled` suffix) for this automation to run.

## License

MIT

## Architecture

Minsky follows a clean, interface-agnostic architecture that separates domain logic from interface-specific concerns. This enables the same core functionality to be used by different interfaces (CLI, MCP, API, etc.) without duplication while maintaining consistency and testability.

### Architectural Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Interface Layer                         │
├─────────────────┬─────────────────┬─────────────────────────┤
│   CLI Commands  │   MCP Server    │   Future Interfaces     │
│   (Terminal)    │   (AI Agents)   │   (Web API, etc.)       │
└─────────────────┴─────────────────┴─────────────────────────┘
         │                 │                     │
         └─────────────────┼─────────────────────┘
                           │
┌─────────────────────────────────────────────────────────────┐
│                     Adapter Layer                           │
├─────────────────┬─────────────────┬─────────────────────────┤
│  CLI Adapters   │  MCP Adapters   │  Shared Commands        │
│                 │                 │  (Command Registry)     │
└─────────────────┴─────────────────┴─────────────────────────┘
         │                 │                     │
         └─────────────────┼─────────────────────┘
                           │
┌─────────────────────────────────────────────────────────────┐
│                      Domain Layer                           │
├─────────────┬───────────┬─────────────┬───────────────────────┤
│   Session   │   Tasks   │    Git      │   Repository &       │
│ Management  │Management │ Operations  │   Workspace          │
└─────────────┴───────────┴─────────────┴───────────────────────┘
                           │
┌─────────────────────────────────────────────────────────────┐
│                Infrastructure Layer                         │
├─────────────┬───────────┬─────────────┬───────────────────────┤
│   Storage   │   Rules   │ Validation  │      Errors          │
│ Backends    │  System   │  (Zod)      │   & Logging          │
└─────────────┴───────────┴─────────────┴───────────────────────┘
```

### Key Components

#### **Domain Layer (`src/domain/`)**

Contains all business logic independent of any interface. These functions are the source of truth for all operations:

- **Session Management** (`session/`): Handles session creation, lifecycle, and workspace management
- **Task Management** (`tasks/`): Implements task CRUD operations with multiple backend support
- **Git Operations** (`git.ts`): Provides Git workflow functionality including PR preparation
- **Repository Management** (`repository/`): Handles different repository backends (local, remote, GitHub)
- **Workspace Management** (`workspace.ts`): Manages workspace resolution and path handling
- **Rules System** (`rules.ts`): Implements rule storage and retrieval
- **Configuration** (`configuration/`): Handles configuration loading and merging

#### **Adapter Layer (`src/adapters/`)**

Implements interface-specific adapters that convert interface inputs into domain function parameters:

- **CLI Adapters** (`cli/`): Commander.js-based CLI interface with argument parsing and output formatting
- **MCP Adapters** (`mcp/`): Model Context Protocol server for AI agent integration
- **Shared Commands** (`shared/`): Interface-agnostic command definitions that can be used by multiple adapters

#### **Command Registry System**

The shared command registry (`src/adapters/shared/command-registry.ts`) enables:

- **Single Source of Truth**: Commands defined once, used by multiple interfaces
- **Type Safety**: Full TypeScript support with Zod schema validation
- **Consistent Behavior**: Same logic regardless of interface (CLI vs MCP)
- **Easy Testing**: Commands can be tested independently of interface concerns

#### **Infrastructure Layer**

- **Schema Layer** (`src/schemas/`): Defines input and output schemas using Zod for validation
- **Storage Backends** (`src/domain/storage/`): Pluggable storage systems (file-based, JSON, etc.)
- **Error Handling** (`src/errors/`): Shared error types and handling across all layers
- **Utilities** (`src/utils/`): Logging, path resolution, and other cross-cutting concerns

### Data Flow

1. **Input Capture**: Interface-specific code captures user input (CLI arguments, MCP requests, etc.)
2. **Parameter Conversion**: Adapter converts interface input to standardized domain parameters
3. **Validation**: Zod schemas validate parameters before domain function execution
4. **Domain Execution**: Domain function performs the core business logic
5. **Result Formatting**: Adapter formats domain output for the specific interface
6. **Output Presentation**: Interface presents result to the user in the appropriate format

### Key Design Patterns

#### **Interface-Agnostic Commands**

Commands are defined once in the shared registry and automatically work across all interfaces:

```typescript
// Command defined once
sharedCommandRegistry.registerCommand({
  id: "session.list",
  category: CommandCategory.SESSION,
  name: "list",
  description: "List all sessions",
  parameters: sessionListParams,
  execute: async (params) => {
    // Domain logic here
    return sessionService.listSessions(params);
  },
});

// Automatically available in CLI
minsky session list

// Automatically available in MCP
{
  "method": "tools/call",
  "params": {
    "name": "session_list",
    "arguments": {}
  }
}
```

#### **Multiple Backend Support**

Both task management and repository access support multiple backends:

- **Task Backends**: Markdown files, JSON databases, GitHub Issues
- **Repository Backends**: Local Git, remote Git, GitHub API
- **Storage Backends**: File system, in-memory (for testing)

#### **Workspace Isolation**

Sessions provide complete workspace isolation:

- Each session gets its own Git branch and workspace directory
- Changes in one session don't affect others
- Sessions can be created from the same repository in parallel

### Benefits of This Architecture

- **Code Reuse**: Domain logic is shared across all interfaces
- **Consistency**: Same behavior regardless of how functionality is accessed
- **Testability**: Domain functions can be tested independently
- **Extensibility**: New interfaces can be added without changing domain logic
- **Type Safety**: Full TypeScript support with runtime validation
- **Maintainability**: Clear separation of concerns makes the codebase easier to understand and modify
