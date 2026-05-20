# Minsky

An exocortex for software organizations led by a principal — the substrate that holds the cognition of one mind across a flock of agents, and translates declared intent into coordinated realized work.

> _"The power of intelligence stems from our vast diversity, not from any single, perfect principle."_ — Marvin Minsky, _The Society of Mind_

The principal — the human responsible for the work — declares intent; the substrate composes hooks, sessions, tasks, asks, memory, and reviewer agents to drive that intent to realization. Principality is recursive: every individual engineer running Minsky is the principal of their own flock, and an organization is a tree of principals all the way down to the ICs. Minsky is principal substrate at every level on that tree.

## What Minsky does

### Task management with multiple backends

Coordinate work items across different storage systems:

```bash
# Minsky database (default)
minsky init --tasks-backend minsky

# GitHub Issues for open source projects
minsky init --tasks-backend github-issues
```

### Session-based development

Isolated workspaces that prevent conflicts and enable parallel work:

```bash
# Start an isolated session for a task
minsky session start --task mt#123

# Work in the isolated environment
cd $(minsky session dir mt#123)

# Create a PR when ready
minsky session pr create --title "Fix critical bug" --type fix
```

### Unified CLI and MCP surfaces

Minsky exposes all commands as both CLI and MCP tools, so AI agents interact with the same surface as human developers. There is no separate AI API — the same `session start`, `tasks create`, and `session pr create` commands work whether a human is typing them in a terminal or an agent is calling them via MCP.

## Why Minsky?

### Not a code review bot

Tools like CodeRabbit, GitHub Copilot Review, and Greptile operate at PR time — they review code after it is written. Minsky audits the development _environment_: the hooks, gates, and workflows that shape how code gets written in the first place. By the time code reaches a PR, Minsky's quality gates have already run many times.

### Not a task tracker

Minsky is the coordination substrate that makes your existing tools work as a coherent system. Your linter, test runner, and CI pipeline already exist — Minsky configures them to run at the right moments and surfaces their results in a consistent format. It does not replace them.

### Alignment through environment, not instruction

The core design principle: the same pre-commit hook that blocks a human developer from committing unformatted code blocks an AI agent too. No special AI configuration is needed. The environment enforces the constraints uniformly.

This is the difference between instruction-based alignment ("tell the AI to write clean code") and environmental alignment ("make unformatted code impossible to commit"). Minsky implements the latter.

### Self-hosted and provider-agnostic

Minsky runs on your infrastructure, in your git repository. It integrates with Anthropic, OpenAI, and Google models via the Vercel AI SDK (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`) — you choose the provider. This contrasts with hosted agent platforms (e.g., Claude Managed Agents) which are cloud-only, single-provider, and designed for async business tasks rather than development workflows.

### Git-native

Sessions are isolated git clones. Changesets are branches. Pull requests are the integration mechanism. There is no proprietary state format — everything lives in git and is inspectable with standard tools.

### Attention as the scarce resource

Underneath every mechanism above sits a scarcer resource than CPU or storage: principal attention. A pre-commit hook catching unformatted code, a session starting from a clean git clone, a `BLOCKED` task surfaced in review — each one routes a decision to the cheapest thing that can resolve it, and pulls in the principal only when nothing cheaper will do.

Two symmetric failure modes follow. **Waste** is asking about choices the substrate could have resolved from policy. **Usurp** is deciding things — architectural calls, precedent-setting naming, scope expansions — that structurally belong to the principal. Minsky treats these as a single routing problem: different kinds of asks (permission, direction, escalation, review, notification) need different transports and cost models, not one-size-fits-all confirmation dialogs.

The full argument — and the emerging ask taxonomy — is in the [companion essay on attention as the binding resource](https://www.notion.so/34a937f03cb4814badbaf2e5cee38c08).

## Quick start

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

### Initialize a project

```bash
# Interactive setup — configures task backend and git hooks
minsky init
```

### Create and work on tasks

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

### Shell completions (bash / zsh / fish)

`minsky` ships tab-completion for bash, zsh, and fish via [@pnpm/tabtab](https://github.com/pnpm/tabtab). One-time setup:

```bash
# Interactive: prompts for which shell to set up
minsky completions install

# Then re-source your shell config (or open a new shell)
exec $SHELL -l
```

After install, tab-complete top-level commands, subcommands, option flags, AND option values:

```
minsky <TAB>                          # → tasks, session, rules, git, config, mcp, ...
minsky tasks <TAB>                    # → list, get, create, status, ...
minsky tasks list --<TAB>             # → --backend, --status, --tag, ...
minsky tasks list --status <TAB>      # → TODO, PLANNING, READY, IN-PROGRESS, ...
minsky git merge --conflict-strategy <TAB>  # → automatic, guided, manual
```

Value completion (`--status <TAB>` → enum values) is automatic for any option whose underlying Zod schema in the shared command registry is a finite enum (`z.enum([...])`, `z.union([z.literal(...), ...])`, or any of those wrapped in `.optional()` / `.default(...)` / `.nullable()`). Free-form options (`z.string()`, `z.number()`) produce no values — those fall through to the shell's default behavior.

To uninstall, run `minsky completions uninstall`. For manual install (bypassing the interactive prompt), `minsky completions bash`, `minsky completions zsh`, or `minsky completions fish` emit the raw completion script to stdout — pipe it into the appropriate shell config.

Dynamic value completion (`tasks get <TAB>` → live task IDs queried from the DB at TAB time) is tracked separately as mt#1894. Windows and PowerShell are not supported.

## Design philosophy

Minsky applies principles from organizational cybernetics — the study of control and communication in complex systems. The right feedback loops and control structures make good practices the path of least resistance:

- **Fast feedback loops** (pre-commit hooks) catch issues immediately
- **Progressive gates** (pre-push, CI/CD) balance thoroughness with productivity
- **Isolation** (session-based development) prevents conflicts and enables parallel work

The central insight is agent equivalence: the incentive structures that guide human developers guide AI agents equally well. This isn't coincidence — it is design. AI agents do not need to be taught to follow best practices; the environment makes following best practices the only path to success, the same as for humans.

For the full theoretical background, see [docs/theory-of-operation.md](./docs/theory-of-operation.md). For the recursive-principality argument (every level of an organization is itself a principal-substrate relationship), see [Position: Levels of principality](https://www.notion.so/366937f03cb4812691c4db4cc44a0776).

## Architecture

Minsky follows a clean architecture with domain logic separated from adapters and infrastructure. The same domain operations (task management, session lifecycle, PR creation) work whether accessed via CLI or MCP. See [docs/architecture.md](./docs/architecture.md) for the system-level walk-through.

## Brand & identity

The brand thesis lives in [Position: Principal substrate vs team substrate](https://www.notion.so/365937f03cb481e78fd5e0594a6507c1) — the unit-of-analysis distinction that names what Minsky is and what it deliberately is not.

The agent-consumable brand foundation — locked myth, cultural code, layered references, vocabulary, bridge-as-affect discipline — lives in the [`minsky-brand`](./.claude/skills/minsky-brand/SKILL.md) skill.

Operational implementation tokens — typography stack, color palette in OKLCH, motion budget with `prefers-reduced-motion`, WCAG contrast targets — live in [`docs/brand-system.md`](./docs/brand-system.md).

Marketing-surface design patterns (Idiom B product-screenshot-dominant, layout, anti-patterns, the new-surface workshop process) live in the [`marketing-site-design`](./.claude/skills/marketing-site-design/SKILL.md) skill.

The principal's literary voice — the corpus-grounded register used in long-form prose — is codified in the [`pz-voice`](./.claude/skills/pz-voice/SKILL.md) skill.

## Contributing

Contributions welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## Documentation

- [Complete documentation](./docs/README.md)
- [Development workflow](./docs/development-workflow.md)
- [Testing guide](./docs/testing.md)
- [Architecture overview](./docs/architecture.md)

## License

MIT — See [LICENSE](./LICENSE) for details.

## Acknowledgments

Named after Marvin Minsky, whose _Society of Mind_ theory inspired the idea that intelligence emerges from the coordination of simpler processes. Just as Minsky proposed that minds are societies of simpler agents, this tool orchestrates development tools into coherent workflows.

The organizational cybernetics principles draw from Stafford Beer's Viable System Model: organizations of humans or AI agents need the same control structures to function effectively.
