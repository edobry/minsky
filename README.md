<p align="center">
  <img src="assets/icon/social-preview.png" alt="Minsky — The cyberbrain for software organizations." width="100%" />
</p>

# Minsky

AI agents can write the code; Minsky is the engineering organization around them — task tracking, isolated workspaces, adversarial review, durable memory, and decision routing, built into the environment itself.

It is also the surface that holds the state of your working life outside your head: every task, session, open question, and lesson across you and your agents — what's in flight, and what actually needs you.

> _"The power of intelligence stems from our vast diversity, not from any single, perfect principle."_ — Marvin Minsky, _The Society of Mind_

**The thesis.** The field now agrees that code is no longer the bottleneck; the disagreement is about what is. The prevailing answer is capability — agents fail sustained work because models aren't smart enough yet, so wait for better ones. Minsky's answer is structure: agents handle isolated tasks well and sustained projects badly because the organization around them — isolation, coordination, review, memory, long-horizon policy — was never built, and those are properties of the environment, not of any agent. Better models make the missing structure more valuable, not less.

That structure is built as environment, not as instruction: the same pre-commit hook that blocks an unformatted commit from a human blocks one from an agent, with no separate AI configuration to maintain. Rules are text, and text is ignorable under pressure; the environment is not. Minsky doesn't write or judge the work — it composes the workspace agents and engineers already run inside, so the right practice is the only path through, not a request an agent could decline.

The human responsible for the work — Minsky calls them the **principal**, whatever their title — declares intent; the environment composes hooks, sessions, tasks, asks, memory, and reviewer agents to drive that intent to reviewed, merged work. Principality is recursive: every individual engineer running Minsky is the principal of their own flock of agents, and an organization is a tree of principals all the way down to the ICs. Minsky is the same substrate at every level of that tree.

The theory behind all of this — the control-system mapping, the attention-as-scarce-resource argument, the humility and noticing properties a substrate needs — is written up, not just implemented; the architecture underneath it is documented the same way.

Theory: [`docs/theory-of-operation.md`](./docs/theory-of-operation.md) — Architecture index: [`docs/architecture.md`](./docs/architecture.md)

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

Minsky is distributed as an npm package (ADR-033). [Bun](https://bun.sh) is a
runtime prerequisite either way — the CLI and the hooks it provisions run under Bun.

```bash
# Install globally (recommended)
bun add -g @edobry/minsky

# Or with npm
npm install -g @edobry/minsky
```

The package is scoped; the command is not. Either install puts a plain `minsky`
on your PATH, and `minsky --version` reports the installed release version.

For development on Minsky itself, install from source instead:

```bash
git clone https://github.com/edobry/minsky.git
cd minsky
bun install
bun link
```

### Initialize a project

```bash
# Interactive setup — configures task backend and git hooks
minsky init

# Developer-local setup — MCP registration + local config + DB connection
minsky setup
```

`minsky setup` owns the database connection so most projects need zero database
thought. It resolves `persistence.postgres.connectionString` through the config
loader first: on a machine that already has a Minsky project configured, it finds
and reuses that connection (printing which config source it came from — user
config, repo config, or an environment variable — after a quick connectivity
check); on a fresh machine with nothing configured, it falls straight into the
same interactive wizard described below. Schema migrations are **not** a manual
step — Minsky auto-migrates the schema on first connect (`MINSKY_AUTO_MIGRATE`
defaults to `true`), so there is never a `minsky persistence migrate` command to
run as part of onboarding.

### Grant the GitHub App access to your repository

Minsky opens pull requests and posts reviews through a GitHub App rather than
your personal token, so the App's installation has to cover each repository you
onboard. `minsky setup` checks this and tells you if it does not.

Expanding an installation's repository access is something only you can do —
GitHub's API restricts it to a personal access token, deliberately, so that an
App cannot widen its own permissions. Minsky therefore does not do it for you.
What it does instead is file a **request** you can see and act on: it names the
repository and the App, links straight to the installation's settings page, and
resolves itself once you grant access. There is nothing to confirm afterwards —
Minsky notices the grant on its own the next time it checks.

Until the grant lands, pull-request creation fails with a bare `404`, and
because the reviewer bot rides the same App's webhooks, code review is blocked
too — not just PR creation.

### Configure the database directly

`minsky setup db` is the same interactive wizard `minsky setup` falls into
automatically, available standalone when you want to (re)configure the database
without touching MCP registration — e.g. to point at a different connection, or
for non-interactive/scripted use:

```bash
minsky setup db
```

It offers three ways to get a connection string:

- **Docker** (detected automatically) — prints a copy-paste one-liner to start a
  local Postgres, then captures the resulting connection string. Minsky does not
  manage the container; you run and stop it with your own Docker.
- **Supabase free tier** — points you at the no-credit-card signup and prompts
  for the connection string.
- **Bring your own** — paste any existing Postgres connection string.

Before writing anything it shows a plan and asks to confirm (the config write is
the only mutating step). It is re-runnable — running it again updates the
connection string and re-verifies.

Non-interactive / scripted use:

```bash
# Supply the connection string directly; --yes skips the confirmation prompt.
minsky setup db --connection-string "postgresql://user:password@host:5432/dbname" --yes

# minsky setup accepts the same two flags, used only if no connection can be
# inherited from existing config:
minsky setup --connection-string "postgresql://user:password@host:5432/dbname" --yes
```

On failure it reports which step failed (`validate` / `connectivity` /
`config-write` / `migrate` / `verify`) with an actionable message; connection
strings are masked in all output.

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

> Notion links below are in the Minsky workspace (private; request access). The agent-consumable skill surfaces and `docs/brand-system.md` are in this repo and require no external account.

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
- [Configuration guide](./docs/configuration-guide.md) — including Braintrust observability setup
- [Postgres persistence & schema migrations](./docs/persistence-configuration.md) — including the bundle-aware migration resolver
- [CI workflows](./docs/ci-workflows.md)

## License

MIT — See [LICENSE](./LICENSE) for details.

## Acknowledgments

Named after Marvin Minsky, whose _Society of Mind_ theory inspired the idea that intelligence emerges from the coordination of simpler processes. Just as Minsky proposed that minds are societies of simpler agents, this tool orchestrates development tools into coherent workflows.

The organizational cybernetics principles draw from Stafford Beer's Viable System Model: organizations of humans or AI agents need the same control structures to function effectively.
