# minsky

[![CI](https://github.com/yourusername/minsky/actions/workflows/ci.yml/badge.svg)](https://github.com/yourusername/minsky/actions/workflows/ci.yml)
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

### Session Commands

#### `minsky session start [options] [session-name]`

Start a new session with the given name. If no name is provided, a random one will be generated.

Options:

- `-r, --repo <repo-url>`: URL of the repository to clone (optional if in a git repository)
- `-t, --task <task-id>`: Task ID to associate with this session
- `--backend <type>`: Repository backend type (local, remote, github)
- `--repo-url <url>`: Remote repository URL for remote/github backends
- `--auth-method <method>`: Authentication method (ssh, https, token)
- `--clone-depth <depth>`: Clone depth for remote repositories
- `--github-token <token>`: GitHub access token for authentication
- `--github-owner <owner>`: GitHub repository owner/organization
- `--github-repo <repo>`: GitHub repository name

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

### Tasks Management

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
minsky session start my-session --backend remote --repo-url https://example.com/repo.git

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
# Start a new session
minsky session start feature-123 --repo https://github.com/org/project.git

# Get session directory
cd $(minsky session dir feature-123)

# Work on code, then generate PR
minsky session pr > PR.md

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

### Remote Repository Workflow

```bash
# Start a session with a GitHub repository
minsky session start github-feature --backend github \
  --github-owner octocat --github-repo hello-world

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

Minsky follows an interface-agnostic architecture that separates domain logic from interface-specific concerns. This allows the same core functionality to be used by different interfaces (CLI, MCP, API, etc.) without duplication.

### Key Components

- **Domain Layer (`src/domain/`)**: Contains all business logic independent of any interface. These functions are the source of truth for all operations.

- **Adapter Layer (`src/adapters/`)**: Implements interface-specific adapters that convert interface inputs into domain function parameters and format domain function outputs for the interface.

  - `src/adapters/cli/`: CLI-specific adapters using Commander.js
  - `src/adapters/mcp/`: Model Context Protocol adapters (for AI integration)

- **Schema Layer (`src/schemas/`)**: Defines input and output schemas for domain functions using Zod.

- **Command Layer (`src/commands/`)**: Legacy command implementations (being migrated to the adapter architecture).

- **Errors (`src/errors/`)**: Shared error types across all layers.

### Function Flow

1. Interface-specific code captures user input (CLI arguments, API request, etc.)
2. Adapter converts input to domain parameters
3. Domain function performs the operation
4. Adapter formats domain output for the interface
5. Interface presents result to the user

This architecture enables:

- Reduced code duplication
- Consistent behavior across interfaces
- Better testability of domain logic
- Easier addition of new interfaces
