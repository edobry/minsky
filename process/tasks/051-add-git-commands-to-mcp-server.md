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

1. [x] Create Git Tools Module

   - [x] Create `src/mcp/tools/git.ts` file (Already existed as adapter-based version in `src/adapters/mcp/git.ts`)
   - [x] Implement `registerGitTools` function
   - [x] Define command mapping structure

2. [x] Implement Core Git Commands

   - [x] Implement `git.clone` command
   - [x] Implement `git.branch` command
   - [x] Implement `git.commit` command (Already implemented)
   - [x] Implement `git.push` command
   - [x] Implement `git.pr` command (Already implemented)

3. [x] Register Git Tools in MCP Server

   - [x] Update `src/commands/mcp/index.ts` to import and register Git tools (Already implemented)
   - [x] Ensure proper error handling for Git command execution

4. [x] Add Command Mapper Support

   - [x] Add `addGitCommand` helper method to `CommandMapper` class (Already implemented)
   - [x] Ensure consistent naming and parameter patterns

5. [x] Documentation and Testing
   - [x] Update README-MCP.md with Git command documentation
   - [x] Add examples of using Git commands via MCP
   - [ ] Create tests for Git MCP tools

## Verification

- [x] All Git commands are properly exposed via MCP
- [x] Commands accept appropriate parameters and validate them correctly
- [x] Command responses are properly formatted as JSON
- [x] Error handling is consistent with other MCP tools
- [x] Documentation accurately reflects the implemented functionality
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
2. 2024-05-19: Added domain interface-agnostic functions for Git commands (clone, branch, push)
3. 2024-05-19: Implemented Git commands in MCP adapter (clone, branch, push)
4. 2024-05-19: Updated README-MCP.md with documentation for Git commands
5. 2024-05-19: Remaining work: Create tests for Git MCP tools
6. 2024-05-19: Fixed implementation to follow session-first workflow by using absolute paths in session workspace

## Implementation Strategy

The implementation followed these principles:

1. **Interface-Agnostic Domain Functions**

   - Created domain-level interface-agnostic functions for all Git operations
   - Functions follow the "FromParams" naming pattern established in the codebase
   - All functions properly propagate errors and include comprehensive logging

2. **MCP Adapter**

   - Extended the existing registerGitTools function to add new commands
   - Used Zod schemas for parameter validation
   - Maintained consistent patterns for error handling and response formatting

3. **Documentation**

   - Updated README-MCP.md with detailed information about the Git commands
   - Included parameter listings and descriptions

4. **Session-First Workflow**

   - All changes were made in the session workspace using absolute paths
   - Followed session-first workflow principles to maintain workspace isolation
   - Used proper verification to ensure changes were made in the correct workspace

5. **Future Improvements**
   - Consider adding more Git operations like:
     - `git.status`: Get status of a repository 
     - `git.log`: View commit history
     - `git.list-branches`: List all branches in a repository

## Abstraction Improvements and Observations

During implementation, several observations were made about the current adapter patterns:

1. **Interface-Agnostic Pattern Consistency**

   - The "FromParams" pattern provides a clean separation between interface-specific code (CLI/MCP) and domain logic
   - This pattern should be consistently applied across all commands to maintain uniformity

2. **Potential Abstraction Improvements**

   - Consider creating a shared adapter utility layer to avoid duplication between CLI and MCP adapters
   - Use of a command registry pattern could streamline adding commands to both CLI and MCP interfaces

3. **Error Handling Patterns**

   - MCP adapters use direct error propagation, while CLI adapters use `handleCliError` helper
   - A common error handling strategy could be established for both adapter types

4. **Parameter Validation**

   - Both adapters rely on Zod schemas, but implement validation differently
   - Could create shared schema definitions that both adapters reference

5. **Response Formatting**
   - CLI adapters use the `outputResult` helper for consistent formatting
   - MCP adapters could benefit from a similar helper to ensure consistent JSON responses

These observations could inform future refactoring work to improve the overall architecture and reduce duplication between adapter implementations.
