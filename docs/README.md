# Minsky Documentation

This directory contains implementation and operational reference documentation
for the Minsky development workflow tool. Strategic memos, position papers, and
incident records live in Notion (Minsky workspace); per-task history lives in
the Minsky task DB and GitHub PRs.

## Getting Started

- [**Main README**](../README.md) — project overview, installation, and basic usage
- [**CONTRIBUTING.md**](../CONTRIBUTING.md) — TypeScript dev setup, testing, and the project record stack
- [**CLAUDE.md**](../CLAUDE.md) — instructions for AI agents working in this codebase
- [**Bun Optimization Setup**](./bun-optimization-setup.md) — disk space optimization (60-90% savings)

## Core Concepts

- [**Domain Concepts**](../src/domain/concepts.md) — Core Minsky concepts (Repository, Session, Workspace)
- [**Theory of Operation**](./theory-of-operation.md) — How cybernetic theory maps to code modules (VSM, environmental pre-delegation)
- [**Architecture Overview**](./architecture.md) — System architecture, command registry, persistence, DI

## Feature Documentation

### Session Management

- [**SessionDB Migration Guide**](./sessiondb-migration-guide.md) — Migrate between SQLite and PostgreSQL backends
- [**SessionDB Troubleshooting Guide**](./sessiondb-troubleshooting.md) — Solutions for common SessionDB issues across all backends
- [**Postgres Persistence Configuration**](./persistence-configuration.md) — Pool sizing, retry policy, and graceful shutdown for the Postgres backend

### Task Management

- [**Multi-Backend User Guide**](./multi-backend-user-guide.md) — Complete guide to the multi-backend task system
- [**Multi-Backend Quick Reference**](./multi-backend-quick-reference.md) — Command reference and cheat sheet
- [**Tasks Dependencies**](./tasks-dependencies.md) — Task dependency model and CLI

### MCP Integration

- [**Shared Command Registry**](./architecture.md#1-shared-command-registry) — How CLI and MCP interfaces share the same command definitions
- [**MCP Server**](../CONTRIBUTING.md#running-the-mcp-server) — How to start and inspect the MCP server locally
- [**MCP Migration Guide**](./mcp-migration-guide.md) — Notes on MCP method/parameter migrations
- [**MCP Schema Composition Guide**](./mcp-schema-composition-guide.md) — Schema patterns for MCP tools
- [**MCP Signaling Spike Findings**](./mcp-signaling-spike-findings.md) — Findings from the mt#1315 signaling spike

### Git Workflows

- [**PR Workflow**](./pr-workflow.md) — Pull request preparation and approval workflows

### Configuration

- [**Configuration Guide**](./configuration-guide.md) — Configuration overview
- [**Configuration Validation Guide**](./configuration-validation-guide.md) — Validation patterns
- [**Repository Configuration**](./repository-configuration.md) — Repository backend configuration
- [**GitHub App Bot Setup**](./github-app-bot-setup.md) — Configure GitHub App bot identity (`minsky-ai[bot]`) for automated PR reviews
- [**GitHub Issues Backend Guide**](./github-issues-backend-guide.md) — GitHub Issues task backend setup

## Architecture & Development

### Development Workflow

- [**Development Workflow**](./development-workflow.md) — Pre-commit hooks, testing, and quality gates

### Testing

For all testing decisions (where to put tests, how to mock, what to test) see the
`testing-guide` skill (`.claude/skills/testing-guide/SKILL.md`). Mocking utilities
live in `src/utils/test-utils/`. Architecture-level docs:

- [**Test Architecture Documentation**](./test-architecture-documentation.md) — Architecture of the test infrastructure

### Architecture (subdirectory)

- [`docs/architecture/`](./architecture/) — ADRs and architecture deep-dives.

## Migrations

- [**Memory Migration**](./memory-migration.md) — Memory subsystem migration notes
- [**Domain Schema Architecture**](./domain-schema-architecture.md) — Domain schema design

## Conventions

- [**ASCII-Only Code Symbols**](#) — see CLAUDE.md (project-wide ASCII rule)
- [**Variable Naming Guide**](./VARIABLE_NAMING_GUIDE.md) — Variable naming conventions
- [**`as unknown` Prevention**](./as-unknown-prevention-guidelines.md) — Guidelines against unsafe `as unknown` casts
- [**Stale Reference Checklist**](./stale-reference-checklist.md) — Checklist for catching stale references during edits
- [**Logging**](./logging.md) — Logging configuration and patterns

## Operations

- [**Deploy Minsky to Railway**](./deploy-minsky-railway.md) — Railway deploy procedure for hosted Minsky MCP

## Reference

### Command Categories

- **Session Management**: `minsky session start|list|get|delete|dir|update|pr|approve`
- **Task Management**: `minsky tasks list|get|create|status|spec|migrate`
- **Git Operations**: `minsky git clone|branch|summary|prepare-pr`
- **Rules Management**: `minsky rules list|get|create|update|search|delete`
- **Configuration**: `minsky config list|show`
- **Project Setup**: `minsky init`
- **MCP Server**: `minsky mcp start`

### Backend Types

- **Task Backends**: `minsky`, `github-issues`
- **Repository Backends**: `local`, `remote`, `github`
- **Session Storage Backends**: `sqlite` (local database), `postgres` (server database)

### Key File Locations

- **Main Configuration**: `.minsky/config.yaml`
- **Task Specs**: stored in the Minsky task DB (browse via `mcp__minsky__tasks_*`)
- **Rules Directory**: `.cursor/rules/` (Cursor format) or `.minsky/rules/` (generic)
- **Session Storage**: `~/.local/state/minsky/sessions/`
- **AI Agent Memory**: `~/.claude/projects/.../memory/` (per-machine, not committed)

## Contributing to Documentation

When updating documentation:

- Keep examples runnable against the current codebase. If a doc claims a tool/utility exists, verify it does.
- Update cross-references when moving content; broken links are surfaced by the stale-reference checklist.
- Prefer linking from this index over duplicating content in multiple places.
- Per-machine, ephemeral, or task-specific documentation does not belong here — that lives in tasks (DB), PRs (GitHub), or memories.

For per-cluster cleanup history, see PRs filed under mt#1319 / mt#1360.
