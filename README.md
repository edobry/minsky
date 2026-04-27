# Minsky

A development workflow orchestration platform that creates collaborative environments for both human and AI developers through organizational cybernetic principles.

> _"The power of intelligence stems from our vast diversity, not from any single, perfect principle."_ — Marvin Minsky, The Society of Mind

## What Minsky Does

### Task Management with Multiple Backends

Coordinate work items across different storage systems:

```bash
# Minsky database (default)
minsky init --tasks-backend minsky

# GitHub Issues for open source projects
minsky init --tasks-backend github-issues
```

### Session-Based Development

Isolated workspaces that prevent conflicts and enable parallel work:

```bash
# Start an isolated session for a task
minsky session start --task mt#123

# Work in the isolated environment
cd $(minsky session dir mt#123)

# Create a PR when ready
minsky session pr create --title "Fix critical bug" --type fix
```

### Unified CLI and MCP Interface

Minsky exposes all commands as both CLI and MCP tools, so AI agents interact with the same interface as human developers. There is no separate AI API — the same `session start`, `tasks create`, and `session pr create` commands work whether you are typing them in a terminal or an agent is calling them via MCP.

## Why Minsky?

### Not a code review bot

Tools like CodeRabbit, GitHub Copilot Review, and Greptile operate at PR time — they review code after it is written. Minsky audits the development _environment_: the hooks, gates, and workflows that shape how code gets written in the first place. By the time code reaches a PR, Minsky's quality gates have already run many times.

### Not a task tracker

Minsky is the coordination layer that makes your existing tools work as a coherent system. Your linter, test runner, and CI pipeline already exist — Minsky configures them to run at the right moments and surfaces their results in a consistent format. It does not replace them.

### Alignment through environment, not instruction

The core design principle: the same pre-commit hook that blocks a human developer from committing unformatted code blocks an AI agent too. No special AI configuration is needed. The environment enforces the constraints uniformly.

This is the difference between instruction-based alignment ("tell the AI to write clean code") and environmental alignment ("make unformatted code impossible to commit"). Minsky implements the latter.

### Self-hosted and provider-agnostic

Minsky runs on your infrastructure, in your git repository. It integrates with Anthropic, OpenAI, and Google models via the Vercel AI SDK (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`) — you choose the provider. This contrasts with hosted agent platforms (e.g., Claude Managed Agents) which are cloud-only, single-provider, and designed for async business tasks rather than development workflows.

### Git-native

Sessions are isolated git clones. Changesets are branches. Pull requests are the integration mechanism. There is no proprietary state format — everything lives in git and is inspectable with standard tools.

### Attention as the scarce resource

Underneath every mechanism above sits a scarcer resource than CPU or storage: operator attention. A pre-commit hook catching unformatted code, a session starting from a clean git clone, a `BLOCKED` task surfaced in review — each one routes a decision to the cheapest thing that can resolve it, and pulls in the operator only when nothing cheaper will do.

Two symmetric failure modes follow. **Waste** is asking about choices the system could have resolved from policy. **Usurp** is deciding things — architectural calls, precedent-setting naming, scope expansions — that structurally belong to the operator. Minsky treats these as a single routing problem: different kinds of asks (permission, direction, escalation, review, notification) need different transports and cost models, not one-size-fits-all confirmation dialogs.

The full argument — and the emerging ask taxonomy — is in the [companion essay](https://www.notion.so/34a937f03cb4814badbaf2e5cee38c08).

## Quick Start

### Installation

```bash
# Clone repository
git clone https://github.com/edobry/minsky.git
cd minsky

# Install with Bun (recommended)
bun install
bun link

# Or with npm
npm install
npm link
```

### Initialize a Project

```bash
# Interactive setup — configures task backend and git hooks
minsky init
```

### Create and Work on Tasks

```bash
# Create a task
minsky tasks create --title "Add user authentication"

# Start a session
minsky session start --task mt#1

# Work in the isolated environment
cd $(minsky session dir mt#1)

# Make changes, then create a PR
minsky session pr create --title "feat: Add user authentication"
```

## Design Philosophy

Minsky applies principles from organizational cybernetics — the study of control and communication in complex systems. By creating the right feedback loops and control structures, good practices become the path of least resistance:

- **Fast feedback loops** (pre-commit hooks) catch issues immediately
- **Progressive gates** (pre-push, CI/CD) balance thoroughness with productivity
- **Isolation** (session-based development) prevents conflicts and enables parallel work

The central insight is agent equivalence: the incentive structures that guide human developers guide AI agents equally well. This isn't coincidence — it is design. We do not need to teach AI agents to follow best practices. We create an environment where following best practices is the only way to succeed, the same as for humans.

For the full theoretical background, see [docs/theory-of-operation.md](./docs/theory-of-operation.md).

## Architecture

Minsky follows a clean architecture with domain logic separated from adapters and infrastructure. The same domain operations (task management, session lifecycle, PR creation) work whether accessed via CLI or MCP. See [docs/architecture.md](./docs/architecture.md) for details.

## Contributing

We welcome contributions. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## Documentation

- [Complete Documentation](./docs/README.md)
- [Development Workflow](./docs/development-workflow.md)
- [Testing Guide](./docs/testing.md)
- [Architecture Overview](./docs/architecture.md)

## License

MIT — See [LICENSE](./LICENSE) for details.

## Acknowledgments

Named after Marvin Minsky, whose "Society of Mind" theory inspired the idea that intelligence emerges from the coordination of simple processes. Just as Minsky proposed that minds are societies of simpler agents, this tool orchestrates development tools into coherent workflows.

The organizational cybernetics principles draw from Stafford Beer's Viable System Model: organizations of humans or AI agents need the same control structures to function effectively.
