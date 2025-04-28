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

### Session Management

```bash
# Start a new session
minsky session start my-session --repo https://github.com/user/repo.git

# Start a session associated with a task
minsky session start --repo https://github.com/user/repo.git --task 001

# List all sessions
minsky session list

# View session details
minsky session get my-session

# View session details by task ID
minsky session get --task 001

# Get session directory
minsky session dir my-session
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

# Set the status of a task
minsky tasks status set --repo /path/to/repo #001 DONE
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
