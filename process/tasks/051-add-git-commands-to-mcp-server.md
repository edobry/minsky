# Task #051: Add Git Commands to MCP Server

## Context

The Minsky Model Context Protocol (MCP) server currently supports task management and session management commands, allowing AI assistants to interact with these features programmatically. However, Git operations, which are a core part of the Minsky workflow, are not yet exposed through the MCP interface. To provide a complete workflow capability for AI agents via MCP, we need to implement Git command support in the MCP server.

## Requirements

1. **Git Command Mapping**

   - Map all existing Git CLI commands to corresponding MCP tools
   - Support the following Git operations through MCP:
     - `git.clone`: Clone a repository
     - `git.branch`: Create a branch in a session repository
     - `git.commit`: Commit changes in a session repository
     - `git.push`: Push changes to remote
     - `git.pr`: Generate a PR document
   - Ensure proper parameter validation and error handling for all Git commands

2. **Parameter Validation and Schema Definition**

   - Define Zod schemas for validating parameters for each Git command
   - Implement proper type safety for all command parameters
   - Provide helpful parameter descriptions in schema definitions

3. **Response Formatting**

   - Format Git command responses as structured JSON data
   - Ensure consistency with existing task and session command responses
   - Include appropriate success/error information in responses

4. **Documentation**
   - Update README-MCP.md to document the new Git commands
   - Provide examples of using Git commands via MCP
   - Include parameter details and response formats in documentation

## Implementation Steps

1. [ ] Create Git Tools Module

   - [ ] Create `src/mcp/tools/git.ts` file
   - [ ] Implement `registerGitTools` function
   - [ ] Define command mapping structure

2. [ ] Implement Core Git Commands

   - [ ] Implement `git.clone` command
   - [ ] Implement `git.branch` command
   - [ ] Implement `git.commit` command
   - [ ] Implement `git.push` command
   - [ ] Implement `git.pr` command

3. [ ] Register Git Tools in MCP Server

   - [ ] Update `src/commands/mcp/index.ts` to import and register Git tools
   - [ ] Ensure proper error handling for Git command execution

4. [ ] Add Command Mapper Support

   - [ ] Add `addGitCommand` helper method to `CommandMapper` class
   - [ ] Ensure consistent naming and parameter patterns

5. [ ] Documentation and Testing
   - [ ] Update README-MCP.md with Git command documentation
   - [ ] Add examples of using Git commands via MCP
   - [ ] Create tests for Git MCP tools

## Verification

- [ ] All Git commands are properly exposed via MCP
- [ ] Commands accept appropriate parameters and validate them correctly
- [ ] Command responses are properly formatted as JSON
- [ ] Error handling is consistent with other MCP tools
- [ ] Documentation accurately reflects the implemented functionality
- [ ] All tests pass

## Dependencies

- Existing MCP server implementation (task #034)
- Existing Git command implementation in Minsky
- CommandMapper and MinskyMCPServer classes

## Notes

- Follow the same pattern as existing task and session commands
- Ensure consistent error handling and response formatting
- Consider future extensions like branch listing, status checking, etc.

## Work Log

1. 2024-05-16: Created task specification for adding Git commands to MCP server, based on analysis of existing MCP implementation and Git command support
