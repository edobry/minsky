---
name: code-organization
description: >-
  Code organization guidance: where to put code, how to structure modules,
  domain-driven organization, file size management, and anti-patterns to avoid.
  Use when deciding where to put new code, refactoring modules, or organizing
  a codebase.
user-invocable: true
---

# Code Organization

Guidance for organizing code by domain concepts with consistent patterns, appropriate module sizes, and clear interfaces.

## Arguments

Optional: description of the organization question (e.g., `/code-organization where should I put the new auth middleware?`).

## Interface-Agnostic Architecture

Minsky implements an interface-agnostic command architecture that separates concerns across three layers:

- **Domain layer** (`src/domain/`) — core business logic; what to do, independent of how it's invoked
- **Adapter layer** (`src/adapters/`) — interface-specific translation; converts input, calls domain functions, formats output
- **Command entry points** (`src/commands/`) — define the external API per interface (CLI, MCP)

### Domain Logic (`src/domain/`)

- Organized by domain concept (e.g., `tasks.ts`, `git.ts`, `session.ts`)
- Contains pure TypeScript functions with proper typing and Zod-based validation
- Interface-agnostic: no CLI or MCP concerns leak in

### Interface Adapters (`src/adapters/`)

- `src/adapters/cli/` — CLI-specific adapters (option parsing, stdout formatting)
- `src/adapters/mcp/` — MCP-specific adapters
- Responsibilities: convert interface input → domain params, call domain function, format result, catch typed errors and translate to interface-appropriate presentation

### Command Entry Points (`src/commands/`)

- `src/commands/mcp/` — MCP command entry points
- CLI commands use Commander.js directly from main index
- Each entry point defines the interface-specific input schema and delegates to the adapter

### Best Practices

1. **Separate concerns** — domain logic must be interface-agnostic; adapters own interface concerns
2. **Match domain to adapters** — `src/domain/tasks.ts` → `src/adapters/cli/tasks.ts` + `src/adapters/mcp/tasks.ts`
3. **Zod validation** — use Zod schemas for parameter validation; define once, reuse across interfaces
4. **Typed errors** — domain functions throw typed errors; adapters catch and format them per interface
5. **Test independently** — unit-test domain functions in isolation; integration-test adapters against their interfaces

## Decision guide

### Where does this code belong?

| Code type             | Location                                                   | Rule                                                                   |
| --------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| Domain/business logic | `src/domain/<module>/`                                     | Organize by what it operates on, not how                               |
| CLI interface         | `src/adapters/cli/`                                        | Only CLI-specific logic (options, output)                              |
| MCP interface         | `src/adapters/mcp/`                                        | Only MCP-specific logic                                                |
| Shared adapter logic  | `src/adapters/shared/`                                     | Command registration, shared utilities                                 |
| Test utilities        | `src/utils/test-utils/`                                    | Standard names: `setup.ts`, `fixtures.ts`, `database.ts`, `mocking.ts` |
| Constants             | Co-locate with domain, or `src/utils/constants/` if shared | Extract when used 3+ times                                             |

### When to split a file

- **>400 lines**: Look for subdomain extraction opportunities
- **Multiple unrelated responsibilities**: Split into focused modules
- Don't split arbitrarily — look for natural domain boundaries

### When to merge files

- Multiple utility files serving the same domain
- Fragmented interfaces that should be consolidated
- Files with only 1-2 small exports that logically belong together

## Anti-patterns

### God Module

- **Symptom**: Single module combining unrelated responsibilities
- **Example**: `isolation.ts` combining state management + data generation + database utilities
- **Fix**: Split into focused modules with single responsibilities
- **Test**: "Would someone immediately understand this module's purpose from its name?"

### Non-Idiomatic Organization

- **Symptom**: Custom patterns when ecosystem standards exist
- **Fix**: Research and follow established patterns for the domain
- **Test**: "Does this follow standard practices other projects use?"

### Vague Naming

- **Symptom**: `utils.ts`, `helpers.ts`, `manager.ts`, `handler.ts`
- **Fix**: Use descriptive names — `setup.ts`, `database.ts`, `fixtures.ts`
- **Test**: "Can someone understand this module without reading the code?"

## Research protocol

Before implementing any non-trivial organization:

1. **Identify the domain** — testing, CLI, data processing, etc.
2. **Study established patterns** — how do successful projects organize similar code?
3. **Question custom solutions** — is there a standard way?
4. **Verify ecosystem fit** — would this be familiar to experienced developers?

### Red flags requiring research

- Creating `utils.ts`, `helpers.ts`, `manager.ts`
- Combining unrelated responsibilities
- Inventing custom patterns when standards exist
- Organization that feels "clever" or "unique"

## Principles

1. **Domain-driven organization** — group by what it operates on, not technical layer
2. **Appropriate module size** — ~400 lines target, extract subdomain when larger
3. **Consistent patterns** — same naming and structure across similar modules
4. **Clear interfaces** — minimize cross-module dependencies, explicit imports
5. **Zero tolerance for unused code** — delete immediately, don't keep "for future use"

## Related rules

- `domain-oriented-modules` — detailed domain grouping constraints
- `file-size` — file size limits
- `constants-management` — string constant organization
- `no-dynamic-imports` — static import preference
