# Contributing to Minsky

This guide is for TypeScript developers who want to contribute to Minsky. It covers
setup, testing, code patterns, and the development workflow.

For AI agent instructions, see [CLAUDE.md](CLAUDE.md).

## Getting Started

### Prerequisites

- **Bun** (runtime and package manager) — install from https://bun.sh
- **Git**
- **PostgreSQL with pgvector** (optional) — only needed for embedding-related features

### Setup

```bash
git clone https://github.com/edobry/minsky.git
cd minsky
bun install
bun link   # makes the `minsky` CLI available globally
```

After `bun link`, you can run `minsky` directly from any directory.

## Running Tests

The test suite uses Bun's built-in test runner. All test commands preload
`tests/setup.ts`, which mocks the logger and suppresses console output during runs.

```bash
# Unit tests (default — fast, no external deps)
bun test --preload ./tests/setup.ts --timeout=15000 ./src ./tests/adapters ./tests/domain

# Shorthand via npm script
bun run test

# Watch mode (re-runs on file changes)
bun run test:watch

# Integration tests (requires database and external services)
bun run test:integration

# All tests including integration
bun run test:all

# Coverage report
bun run test:coverage
```

The `--preload ./tests/setup.ts` flag is required whenever you run tests manually.
Omitting it will produce noisy console output and may cause test failures.

### Debug mode

Set `DEBUG_TESTS=1` to disable console mocking and see full output:

```bash
DEBUG_TESTS=1 bun test --preload ./tests/setup.ts src/domain/tasks
```

## Testing Patterns

Minsky uses **constructor injection** with fake implementations — not `mock.module()`.
The ESLint rule `custom/no-global-module-mocks` enforces this: `mock.module()` is
banned in test files (the one exception is `tests/setup.ts` for the logger).

### The fake provider pattern

Define a plain object that satisfies the interface, pass it via the constructor:

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { TaskRoutingService } from "../../src/domain/tasks/task-routing-service";
import type { TaskGraphService } from "../../src/domain/tasks/task-graph-service";
import type { TaskServiceInterface } from "../../src/domain/tasks/taskService";

const mockTaskGraphService: TaskGraphService = {
  listDependencies: async (taskId: string) => [],
  listDependents: async () => [],
  addDependency: async () => {},
  removeDependency: async () => {},
  getAllRelationships: async () => [],
  getRelationshipsForTasks: async () => [],
} as unknown as TaskGraphService;

const mockTaskService: TaskServiceInterface = {
  listTasks: async () => [],
  getTask: async () => null,
} as unknown as TaskServiceInterface;

describe("TaskRoutingService", () => {
  let service: TaskRoutingService;

  beforeEach(() => {
    // Inject fakes through the constructor — no module mocking needed
    service = new TaskRoutingService(mockTaskGraphService, mockTaskService);
  });

  test("finds available tasks", async () => {
    const result = await service.findAvailableTasks({ statusFilter: ["TODO"], limit: 10 });
    expect(result).toEqual([]);
  });
});
```

Key principles:

- Fake objects implement only the methods the test exercises.
- Use `as unknown as InterfaceType` when the fake is intentionally partial.
- Never use `mock.module()` outside of `tests/setup.ts`.
- Tests must not touch the real filesystem, real SQLite, or real git repos — the
  `custom/no-real-fs-in-tests` lint rule enforces this.

## Adding New Commands

Minsky uses a **shared command registry** (`src/adapters/shared/command-registry.ts`).
A command defined once in the registry is automatically available in both the CLI
and the MCP server — no adapter duplication required.

### Steps to add a command

1. **Define the command** using `defineCommand` with a Zod parameter schema:

```ts
import { z } from "zod";
import { defineCommand, CommandCategory } from "../command-registry";

export const myCommand = defineCommand({
  id: "tasks.my-command",
  category: CommandCategory.TASKS,
  name: "my-command",
  description: "Does something useful",
  parameters: {
    taskId: {
      schema: z.string(),
      description: "The task ID to operate on",
      required: true,
    },
    force: {
      schema: z.boolean().default(false),
      description: "Skip confirmation",
      required: false,
    },
  },
  execute: async (params, ctx) => {
    // params.taskId and params.force are fully typed
    return { result: "done" };
  },
});
```

2. **Register it** in the appropriate commands file under
   `src/adapters/shared/commands/`. Browse that directory for examples of existing
   command groups.

3. **No CLI or MCP adapter changes needed** — the registry wires both automatically.

See `src/adapters/shared/` for the full set of existing commands organized by domain.

## Code Style

- **TypeScript strict mode** — no implicit `any`, strict null checks
- **Double quotes** for strings
- **2-space indentation**
- **100-character line width**
- **ES5 trailing commas** (objects, arrays, function parameters)
- **LF line endings**
- **Template literals** preferred over string concatenation (`prefer-template` is an error)
- **No `var`** — use `const` or `let`

Run the formatter and linter:

```bash
bun run format:check   # check formatting (Prettier)
bun run format:all     # format and auto-fix lint issues
bun run lint           # ESLint only
bun run typecheck      # tsgo --noEmit
bun run validate-all   # run all checks (format + lint + typecheck + tests)
```

### Custom ESLint rules

The project enforces 12 custom rules under the `custom/` prefix:

| Rule                            | Level | Purpose                                         |
| ------------------------------- | ----- | ----------------------------------------------- |
| `no-underscore-prefix-mismatch` | error | Underscore prefix must match actual usage       |
| `no-jest-patterns`              | error | Prevents Jest API usage (project uses Bun test) |
| `no-real-fs-in-tests`           | warn  | Tests must not touch the real filesystem        |
| `no-global-module-mocks`        | error | `mock.module()` banned outside `tests/setup.ts` |
| `no-unreliable-factory-mocks`   | warn  | Prevents async factory race conditions          |
| `no-cli-execution-in-tests`     | warn  | Flags architectural violations in tests         |
| `no-magic-string-duplication`   | warn  | Encourages extracting repeated string literals  |
| `no-unwaited-async-factory`     | error | Prevents unwaited async factory calls           |
| `no-singleton-reach-in`         | warn  | Keeps singleton resolution in composition roots |
| `no-tests-directories`          | warn  | Encourages co-located test files                |
| `no-unsafe-git-exec`            | error | All git operations must have timeout protection |
| `no-excessive-as-unknown`       | warn  | Discourages overuse of `as unknown` casts       |

## Rules Storage Model

Minsky rules are authored in `.minsky/rules/` and compiled to harness-specific outputs
(`.cursor/rules/`, `AGENTS.md`, `CLAUDE.md`). The split matters:

- **`.minsky/rules/`** — canonical source. Edit rule files here. `minsky rules create`
  lands new rules here by default.
- **`.cursor/rules/`** — compile output, regenerated from `.minsky/rules/` by
  `bun run minsky rules compile --target cursor-rules`. Do not hand-edit — changes will
  be overwritten on the next compile.
- **`AGENTS.md`, `CLAUDE.md`** — monolithic compile outputs; same "don't hand-edit"
  rule applies. Both are in `.prettierignore` so Prettier doesn't fight the compiler.

The pre-commit hook step 9 (see below) enforces that the committed `.cursor/rules/` and
`AGENTS.md` match what the compiler would produce from `.minsky/rules/`. If you edit
a rule, re-run `minsky rules compile` and commit both locations together.

**Migrating an existing project** from `.cursor/rules/`-as-source to `.minsky/rules/`-as-source:

```bash
bun run minsky rules migrate        # copies .cursor/rules/*.mdc → .minsky/rules/*.mdc
bun run minsky rules compile --target cursor-rules    # regenerate .cursor/rules/
git add .minsky/rules/ .cursor/rules/
```

After migration, `.minsky/rules/` is authoritative. `minsky rules migrate --dry-run`
shows what would change without writing, and `--force` overwrites any existing files
in the destination.

## Pre-commit Hooks

Husky runs a TypeScript pre-commit hook (`src/hooks/pre-commit.ts`) that enforces
quality gates in order from fastest to slowest:

1. **Code formatting** — Prettier via lint-staged (staged files only, ~1s)
2. **Console usage validation** — catches bare `console.log` in non-test code (~1s)
3. **Variable naming check** — underscore prefix mismatch detection (~1s)
4. **TypeScript type checking** — `tsgo --noEmit` (~1.5s)
5. **ESLint** — full lint with zero-error gate (~5–10s)
6. **Secret scanning** — gitleaks (~2–3s)
7. **Unit tests** — full test suite (~15–30s)
8. **ESLint rule tests** — tests for the custom lint rules
9. **Rules compile staleness check** — runs `minsky rules compile --check` for each
   opted-in target (AGENTS.md, CLAUDE.md, `.cursor/rules/`). If a compiled output is
   out of date relative to the source rules, the commit is blocked with a message
   naming the stale file. Remediation: run `bun run minsky rules compile --target <target>`
   and re-stage the regenerated output.

The **commit-msg** hook validates commit message format (Conventional Commits style:
`type(scope): description`).

The **pre-push** hook runs the unit test suite again before pushing to the remote.

If a hook fails, fix the reported issue and re-stage — the commit has not been
created yet, so there is no need to amend.

## Development Workflow

Minsky uses **sessions** for all development work. A session is an isolated git
clone on a dedicated branch.

### Typical flow

```bash
# Create a task (optional — for tracked work)
minsky tasks create "My feature" --description "..."

# Start a session (creates a branch and working directory)
minsky session start --task <task-id>
# or for untracked work:
minsky session start --name my-feature

# The session directory is printed — work there
cd ~/.local/state/minsky/sessions/<session-id>/

# Edit files, run tests...
bun run test
bun run validate-all

# Commit (use the minsky CLI, not bare git)
minsky session commit -m "feat: add my feature"

# Open a PR
minsky session pr create --title "feat: my feature" --type feat
```

Session directories are at `~/.local/state/minsky/sessions/<uuid>/`. Each session
tracks its own branch (`task/<backend>-<id>` format).

After a PR is merged, delete the session and start a fresh one for any follow-up
work — sessions are frozen after merge.

## Running the MCP Server

Minsky can run as an MCP (Model Context Protocol) server, exposing all commands
as MCP tools:

```bash
bun run src/cli.ts mcp start
```

You can inspect the MCP server using the official MCP inspector:

```bash
npx @modelcontextprotocol/inspector bun run src/cli.ts mcp start
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for a full description of the
layered architecture (Domain → Adapters → Infrastructure), the command registry
pattern, and the DI container design.

## Further Reading

- [README.md](README.md) — project overview and quick-start
- [CLAUDE.md](CLAUDE.md) — instructions for AI agents working in this codebase
- [docs/](docs/) — architecture decisions, design documents, and ADRs
