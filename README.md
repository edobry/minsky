# minsky

A tool for coordinating AI agent workflows using Git and other collaboration tools, inspired by Marvin Minsky's "Society of Mind" theory and organizational cybernetics.

> **⚠️ Note:** This is an experimental project under active development. Not suitable for production use.

## Overview

Minsky helps AI agents collaborate on codebases by leveraging the same tools human engineers use:

- **Git repositories** for version control
- **Isolated workspaces** to prevent conflicts
- **Branch-based workflows** for parallel development
- **Pull request summaries** to document changes

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

### Session Management

```bash
# Start a new session
minsky session start my-session --repo https://github.com/user/repo.git

# List all sessions
minsky session list

# View session details
minsky session get my-session

# Navigate to session directory
cd $(minsky session cd my-session)
```

## Example Workflows

### Basic Development Flow

```bash
# Start a new session
minsky session start feature-123 --repo https://github.com/org/project.git

# Navigate to session directory
cd $(minsky session cd feature-123)

# Work on code, then generate PR
minsky git pr --session feature-123 > PR.md
```

### Multi-Agent Collaboration

Multiple agents can work on related features in parallel:

```bash
# Agent 1: Authentication backend
minsky session start auth-api --repo https://github.com/org/project.git

# Agent 2: Frontend integration
minsky session start auth-ui --repo https://github.com/org/project.git
```

Each agent works in its own isolated environment and can generate PR documents to share their changes.

## Future Plans

- Team organization patterns for agents
- Session continuity and context management
- Automated code reviews
- Task planning and allocation

## Contributing

This project is a research experiment in non-human developer experience. Ideas, issues and PRs are welcome!

## License

MIT
