# Task #052: Add Remaining Task Management Commands to MCP

## Context

The Minsky Model Context Protocol (MCP) server currently supports basic task management commands (`tasks.list`, `tasks.get`, `tasks.status.get`, `tasks.status.set`, `tasks.create`), but does not expose the full range of task management capabilities available in the CLI. To provide complete task management functionality for AI agents via MCP, we need to implement the remaining task management commands.

## Requirements

1. **Complete Task Command Mapping**

   - Ensure all task management CLI commands are mapped to corresponding MCP tools
   - Add support for the following additional task operations through MCP:
     - `tasks.delete`: Delete a task (if applicable in CLI)
     - `tasks.update`: Update task details (if applicable in CLI)
     - `tasks.filter`: Enhanced task filtering capabilities
     - `tasks.info`: Get statistical information about tasks
   - Support all command options and flags available in the CLI

2. **Enhanced Parameter Validation**

   - Define comprehensive Zod schemas for validating parameters for all task commands
   - Support complex filtering and query options for task listing
   - Provide rich metadata and descriptions in schema definitions for AI understanding

3. **Workspace-Aware Operations**

   - Ensure task commands respect workspace context and session isolation
   - Support workspace, repo, and session parameters for all task commands
   - Add proper workspace path validation and resolution

4. **Documentation and Examples**
   - Update README-MCP.md to document all task management commands
   - Provide comprehensive examples for each command
   - Include parameter details and response formats

## Implementation Steps

1. [ ] Analyze Current Task Command Coverage

   - [ ] Compare existing MCP task tools with available CLI commands
   - [ ] Identify missing commands and options
   - [ ] Document function mappings between CLI and MCP

2. [ ] Implement Missing Task Commands

   - [ ] Implement any missing task command operations
   - [ ] Ensure all CLI options are supported
   - [ ] Add workspace context handling to all commands

3. [ ] Enhance Existing Task Commands

   - [ ] Review existing task command implementations
   - [ ] Add missing options and parameters
   - [ ] Improve error handling and response formatting

4. [ ] Documentation and Testing
   - [ ] Update README-MCP.md with comprehensive task command docs
   - [ ] Create examples for all task operations via MCP
   - [ ] Implement tests for all task command scenarios

## Verification

- [ ] All CLI task commands are available via MCP
- [ ] Commands accept the same parameters as their CLI counterparts
- [ ] Workspace context is properly handled
- [ ] Command responses are consistently formatted
- [ ] Error handling is robust and provides clear messages
- [ ] Documentation is complete and accurate
- [ ] All tests pass

## Dependencies

- Existing MCP server implementation (task #034)
- Existing task command implementation in Minsky CLI
- CommandMapper and MinskyMCPServer classes

## Notes

- Follow existing patterns for command mapping and parameter validation
- Consider bulk operations for task management where applicable
- Ensure consistent error handling and response formatting
- Consider integration with session-scoped MCP (task #049) for proper workspace isolation

## Work Log

1. 2024-05-16: Created task specification for adding remaining task management commands to MCP server, based on analysis of existing implementation and command coverage
