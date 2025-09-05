# Minsky

A development workflow orchestration platform that creates collaborative environments for both human and AI developers through organizational cybernetic principles.

> _"The power of intelligence stems from our vast diversity, not from any single, perfect principle."_ — Marvin Minsky, The Society of Mind

## Philosophy

Minsky operates on a fundamental principle: **the mechanisms that coordinate human developers work equally well for AI agents**. By implementing organizational cybernetic control structures—the same feedback loops, quality gates, and workflow patterns that guide human teams—we create environments where both humans and AI naturally produce high-quality work.

This isn't about making special tools for AI. It's about recognizing that good development practices emerge from well-designed systems, not individual discipline. A pre-commit hook that blocks unformatted code shapes behavior the same way whether the committer is human or artificial.

## Core Concepts

### Development Workflow Orchestration

Rather than building yet another linter, test runner, or task tracker, Minsky orchestrates your existing tools into coherent workflows. Like a conductor who doesn't play instruments but ensures each section performs at the right moment, Minsky coordinates when and how your development tools run.

### Organizational Cybernetics

Minsky applies principles from organizational cybernetics—the study of control and communication in complex systems. By creating the right feedback loops and control structures, we shape an environment where good practices become the path of least resistance:

- **Fast feedback loops** (pre-commit hooks) catch issues immediately
- **Progressive gates** (pre-push, CI/CD) balance thoroughness with productivity
- **Visibility mechanisms** (workflow maturity scores) make quality tangible
- **Automation** makes good practices easier than bad ones

### Agent Equivalence

The same incentive structures that guide human behavior guide AI behavior. This isn't coincidence—it's design.

**We don't need to teach AI to follow best practices.** We create an environment where following best practices is the only way to succeed, just like for humans. This is the key insight: alignment isn't achieved through training or instruction, but through environmental design.

Consider how this works in practice:

- A human developer can't commit code with linting errors—the pre-commit hook blocks it
- An AI agent can't commit code with linting errors—the same hook blocks it
- Neither needs to be "taught" to value clean code; the environment enforces it

This is mechanism design at work. By shaping the incentive landscape through tooling and automation, we make good practices inevitable rather than aspirational. The AI doesn't need to understand _why_ formatting matters—it just needs to operate in an environment where unformatted code literally cannot be committed.

The beauty of this approach is that it's already proven. These are the same organizational cybernetic structures that have guided human teams to quality for decades. We're not inventing new constraints for AI; we're applying the same time-tested control mechanisms that work for any intelligent agent operating in the system.

## What Minsky Provides

### 1. Task Management with Multiple Backends

Coordinate work items across different storage systems:

```bash
# Markdown files for simple projects
minsky init --tasks-backend markdown

# GitHub Issues for open source
minsky init --tasks-backend github

# Database for complex workflows
minsky init --tasks-backend minsky
```

### 2. Session-Based Development

Isolated workspaces that prevent conflicts and enable parallel work:

```bash
# Start a session for a task
minsky session start --task mt#123

# Work in isolated environment
cd $(minsky session dir mt#123)

# Prepare changes for review
minsky session pr create --title "Fix critical bug" --type fix
# Changeset aliases also available:
minsky session changeset create --title "Fix critical bug" --type fix
minsky session cs create --title "Fix critical bug" --type fix
```

### 3. Workflow Orchestration

Configure your existing tools and let Minsky coordinate them:

```yaml
# In minsky.yaml or minsky.json
workflows:
  lint:
    json: "eslint . --format json"
    fix: "eslint . --fix"
  test:
    json: "bun test --reporter json"
  security:
    json: "gitleaks detect --format json"
```

### 4. Development Maturity Assessment

Understand and improve your project's automation:

```bash
# Assess current workflow maturity
minsky workflow assess

# Development Workflow Maturity Assessment
# Overall Score: 72/100 (Level 3 - DEFINED)
#
# ✅ Code Quality        ████████░░  80%
# ⚠️  Testing            ██████░░░░  60%
# ❌ Security            ░░░░░░░░░░   0%

# Interactively configure missing workflows
minsky workflow init
```

### 5. AI Context Generation

Provide rich context for AI pair programming:

```bash
# Generate context matching Cursor's format
minsky context generate

# Include session and task information
minsky context generate --session mt#123
```

## Installation

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

## Quick Start

### Initialize a Project

```bash
# Interactive setup
minsky init

# This will:
# 1. Set up task management backend
# 2. Detect your project type
# 3. Assess workflow maturity
# 4. Configure development workflows
# 5. Set up git hooks
```

### Create and Work on Tasks

```bash
# Create a task
minsky tasks create --title "Add user authentication"

# Start a session
minsky session start --task mt#1

# Work in isolated environment
cd $(minsky session dir mt#1)

# Make changes...

# Create PR when ready
minsky session pr create --title "feat: Add user authentication"
```

### Manage Workflows

```bash
# Run specific workflow
minsky workflow run lint

# Run with fix
minsky workflow run lint --fix

# Check what's configured
minsky workflow list
```

## Why Minsky?

### For Human Developers

- **Consistency**: Same development environment across all projects
- **Automation**: Reduce manual quality checks
- **Visibility**: Understand your project's maturity
- **Simplicity**: One tool orchestrates all others

### For AI Agents

- **Clear constraints**: Unambiguous quality gates
- **Structured feedback**: JSON output from all tools
- **Isolated environments**: Safe experimentation
- **Consistent context**: Same information humans see

### For Teams

- **Shared standards**: Everyone uses same workflows
- **Parallel development**: Multiple sessions prevent conflicts
- **Quality gates**: Automated checks before integration
- **Transparent process**: Clear workflow visibility

## Architecture

Minsky follows a clean architecture with clear separation between:

- **Domain**: Core business logic (tasks, sessions, workflows)
- **Adapters**: CLI and MCP interfaces
- **Infrastructure**: Storage backends, git operations

This design ensures the same domain logic works whether accessed via CLI or through the MCP protocol for AI agents.

## Configuration

Minsky uses a flexible configuration system supporting both YAML and JSON:

```yaml
# minsky.yaml
tasks:
  backend: markdown # or: github, json-file, minsky

workflows:
  lint:
    json: "eslint . --format json"
  test:
    json: "jest --json"

rules:
  format: cursor # or: generic
```

## Contributing

We welcome contributions! The key is understanding that Minsky isn't trying to reinvent development tools—it's creating the coordination layer that makes existing tools work together effectively.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## Documentation

- [Complete Documentation](./docs/README.md)
- [Development Workflow](./docs/development-workflow.md)
- [Testing Guide](./docs/testing.md)
- [Architecture Overview](./docs/architecture.md)

## License

MIT - See [LICENSE](./LICENSE) for details.

## Acknowledgments

Named after Marvin Minsky, whose "Society of Mind" theory inspired the idea that intelligence emerges from the coordination of simple processes. Just as Minsky proposed that minds are societies of simpler agents, this tool orchestrates simple development tools into intelligent workflows.

The organizational cybernetics principles come from Stafford Beer's Viable System Model and the recognition that organizations (whether of humans or AI agents) need the same control structures to function effectively.
