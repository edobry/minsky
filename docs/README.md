# Minsky Documentation

This directory contains comprehensive documentation for the Minsky development workflow tool.

## Getting Started

- [**Main README**](../README.md) - Overview, installation, and basic usage
- [**Bun Optimization Setup**](./bun-optimization-setup.md) - **Recommended**: Configure disk space optimization (60-90% savings)
- [**Example Guide**](./EXAMPLE_GUIDE.md) - Comprehensive examples and workflows
- [**Migration Guides**](./MIGRATION_GUIDES.md) - Migration guides for different versions and backends

## Core Concepts

- [**Domain Concepts**](../src/domain/concepts.md) - Core Minsky concepts (Repository, Session, Workspace)
- [**Architecture Overview**](../README.md#architecture) - System architecture and design patterns

## Feature Documentation

### Session Management

- [**SessionDB Migration Guide**](./sessiondb-migration-guide.md) - Migrate between JSON, SQLite, and PostgreSQL backends
- [**SessionDB Troubleshooting Guide**](./sessiondb-troubleshooting.md) - Solutions for common SessionDB issues across all backends

### Task Management

- [**JSON Task Backend**](./JSON-TASK-BACKEND.md) - JSON-based task storage system
- [**JSON Backend Migration**](./JSON-TASK-BACKEND-MIGRATION.md) - Migrating from markdown to JSON tasks

### MCP Integration

- [**MCP README**](../README-MCP.md) - Model Context Protocol server documentation
- [**MCP Usage**](../README.md#mcp-model-context-protocol-support) - MCP integration and AI agent support

### Git Workflows

- [**PR Workflow**](./pr-workflow.md) - Pull request preparation and approval workflows

### Configuration

- [**Bun Optimization Setup**](./bun-optimization-setup.md) - Disk space optimization configuration (recommended)
- [**Repository Configuration**](./repository-configuration.md) - Repository backend configuration

## Architecture & Development

### Design Patterns

- [**Interface-Agnostic Commands**](./architecture/interface-agnostic-commands.md) - Command architecture patterns
- [**Preventing Bypass Patterns**](./architecture/preventing-bypass-patterns.md) - Architectural safeguards

### System Architecture

- [**Post-125 Stability Plan**](./architecture/post-125-stability-plan.md) - System stability and reliability
- [**SessionDB Multi-Backend Architecture**](./architecture/sessiondb-multi-backend-architecture.md) - Session storage system design and implementation
- [**Validation Error Handling**](./architecture/validation-error-handling.md) - Error handling patterns

## Testing & Quality

### Testing Infrastructure

- [**Testing Best Practices**](./TESTING_BEST_PRACTICES.md) - Testing guidelines and patterns
- [**Test Utilities**](./TEST_UTILITIES.md) - Available testing utilities and helpers
- [**Mocking Utilities**](./MOCKING_UTILITIES.md) - Mocking patterns and utilities
- [**Mock Compatibility**](./testing/mock-compatibility.md) - Mock compatibility guidelines

### Development Tools

- [**Logging**](./logging.md) - Logging configuration and patterns

## Integration & Compatibility

- [**Compatibility Layer**](./COMPATIBILITY_LAYER.md) - Backward compatibility guidelines
- [**Migration Guides**](./MIGRATION_GUIDES.md) - Version migration instructions

## Quick Reference

### Command Categories

- **Session Management**: `minsky session start|list|get|delete|dir|update|pr|approve`
- **Task Management**: `minsky tasks list|get|create|status|spec|migrate`
- **Git Operations**: `minsky git clone|branch|summary|prepare-pr`
- **Rules Management**: `minsky rules list|get|create|update|search|delete`
- **Configuration**: `minsky config list|show`
- **Project Setup**: `minsky init`
- **MCP Server**: `minsky mcp start`

### Backend Types

- **Task Backends**: `markdown`, `json-file`, `github-issues`
- **Repository Backends**: `local`, `remote`, `github`
- **Session Storage Backends**: `json` (file-based), `sqlite` (local database), `postgres` (server database)

### Key File Locations

- **Main Configuration**: `.minsky/config.json`
- **Task Files**: `process/tasks.md` (markdown) or JSON database (json-file)
- **Rules Directory**: `.cursor/rules/` (Cursor format) or `.minsky/rules/` (generic)
- **Session Storage**: `~/.local/state/minsky/git/`

## Documentation Status

### ✅ Complete Documentation

- Core concepts and architecture
- Session management workflows
- Task management with multiple backends
- MCP integration for AI agents
- Git workflows and PR preparation
- Rules management system
- Configuration management
- Project initialization

### 🔄 Recently Updated

- Architecture documentation with detailed diagrams
- Command reference with all options
- Backend configuration examples
- Testing and development guidelines

### 📋 Documentation Standards

This documentation follows these standards:

- **Accuracy**: All examples are tested and current
- **Completeness**: All major features and commands are documented
- **Structure**: Logical organization with clear navigation
- **Usability**: Examples and workflows for common use cases
- **Maintainability**: Easy to update as features evolve

## Contributing to Documentation

When updating documentation:

1. Keep examples current and tested
2. Update cross-references when moving content
3. Follow the established structure and style
4. Include both basic usage and advanced examples
5. Document any breaking changes in migration guides

For questions or suggestions about documentation, please open an issue or contribute improvements via pull request.
