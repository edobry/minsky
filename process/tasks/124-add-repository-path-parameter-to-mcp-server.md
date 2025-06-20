# Add Repository Path Parameter to MCP Server

## Context

The Minsky MCP server is currently being initialized without knowledge of which repository to operate on. This causes problems when using MCP tools like `tasks_list`, as they don't have the context needed to find tasks, even when tasks exist in the repository. In normal CLI operation, the working directory provides this context, but MCP tools need explicit repository information.

## Requirements

1. **MCP Server Repository Context**

   - Add a `--repo <path>` parameter to the `minsky mcp start` command
   - Store this repository path at the MCP server level
   - Use it as the default context for all MCP operations

2. **Tool Parameter Integration**

   - Make the repository path parameter optional in MCP tools
   - Tools should use the server-level repository path as default if no explicit path is provided
   - Allow overriding the default path for specific operations

3. **Configuration Integration**

   - Ensure the `.cursor/mcp.json` can specify the workspace path at server start time
   - Document how to configure this in Cursor and other MCP clients

4. **Error Handling**
   - Gracefully handle missing repository path
   - Provide clear error messages when operations fail due to repository context issues

## Implementation Plan

### 1. Create a Project Context Concept

1. Create a new `ProjectContext` interface in a central location to represent project-specific context:

   - Currently will include `repositoryPath` but designed for future expansion
   - Create proper utilities for validating and normalizing paths

2. Implementation details:
   - Define the interface with clear JSDoc documentation
   - Include utility functions for path validation and normalization
   - Make it easy to extend in the future with additional context information

### 2. Update MinskyMCPServerOptions Interface and Constructor

1. The `src/mcp/server.ts` file needs to be modified to:

   - Add the `ProjectContext` to the `MinskyMCPServerOptions` interface
   - Store the project context in the server instance during construction
   - Add a getter method to access the project context from outside

2. Implementation details:
   - The project context will be optional in the interface with appropriate defaults
   - Include validation to ensure the repository path exists when provided

### 3. Update MCP Start Command

1. The `src/commands/mcp/index.ts` file needs to be modified to:

   - Add a `--repo <path>` option to the start command with appropriate documentation
   - Set the default to `process.cwd()` if not specified
   - Create a ProjectContext and pass it to the server instance during initialization

2. Implementation details:
   - Update the option parsing in the `startCommand.action()` function
   - Add validation to ensure the path exists before starting the server
   - Fail with clear error messages for invalid paths

### 4. Modify the CommandMapper for Project Context

1. The `src/mcp/command-mapper.ts` file needs to be modified to:

   - Add a `projectContext` property to store the server's project context
   - Create methods to access and use the project context in tool execution
   - Add a parameter to all command methods to allow overriding specific parts of the context

2. Implementation details:
   - Update the constructor to accept and store the project context
   - Create methods to retrieve the project context information
   - Update all tool registration methods to understand the project context

### 5. Update MCP Tool Implementations

1. The adapter files (`src/adapters/mcp/*.ts`) need to be modified to:

   - Add optional project context parameters to all tool functions
   - Use the server-level project context as default if no override is provided
   - Pass the appropriate context to the domain functions

2. Implementation details:
   - Begin with the tasks.ts adapter, as it's the most critical for this functionality
   - Add project context parameter to parameter schemas in each tool registration
   - Ensure domain functions receive the correct repository path

### 6. Update Documentation

1. The `README-MCP.md` file needs to be updated to:

   - Document the new `--repo` parameter for the `minsky mcp start` command
   - Explain how MCP tools use the project context
   - Include examples for Cursor configuration in `.cursor/mcp.json`

2. Implementation details:
   - Add a section on project context in the MCP documentation
   - Include example configurations and use cases

### 7. Add Tests

1. Create new tests for:

   - Project context creation and validation
   - MCP server initialization with project context
   - Tool execution with default and overridden project context
   - Error scenarios with invalid repository paths

2. Implementation details:
   - Add unit tests for MCP server with project context
   - Add integration tests for tools using the project context
   - Test error cases with invalid paths

## Implementation Steps

1. [ ] Create `ProjectContext` interface and utilities

   - [ ] Define the interface with repositoryPath and future expansion in mind
   - [ ] Add validation and normalization utilities
   - [ ] Document the interface thoroughly

2. [ ] Update `MinskyMCPServerOptions` interface to include `projectContext`

   - [ ] Add documentation for the new option
   - [ ] Update constructor to store the project context
   - [ ] Add getter method for project context access

3. [ ] Modify `mcp start` command to accept repository path

   - [ ] Add `--repo <path>` option with appropriate documentation
   - [ ] Set default to `process.cwd()` if not specified
   - [ ] Create and pass project context to server instance
   - [ ] Add validation with clear error messages

4. [ ] Update command mapper and tool implementations

   - [ ] Add project context parameter to CommandMapper class
   - [ ] Add methods to retrieve and use project context
   - [ ] Update task tools to use server-level project context
   - [ ] Update session, git, and rule tools similarly

5. [ ] Add documentation

   - [ ] Update README-MCP.md with information about project context
   - [ ] Add examples for Cursor configuration

6. [ ] Add tests for new functionality
   - [ ] Test project context initialization and validation
   - [ ] Test MCP server with project context
   - [ ] Test tool execution with and without explicit context
   - [ ] Test error handling for invalid repository paths

## Verification

- [ ] MCP server starts correctly with specified repository path
- [ ] MCP tools can find and list tasks without requiring explicit repository path
- [ ] Tools can override the default repository path when needed
- [ ] Error messages are clear and helpful when repository issues occur
- [ ] No regressions in existing MCP functionality
- [ ] Documentation is clear and comprehensive

## Technical Notes and Considerations

1. **Project Context Design**:

   - Start with repository path but design for extension
   - Use clear interface definition with optional properties
   - Include validation as part of the context creation

2. **Path Validation**:

   - Create centralized validation utilities
   - Define clear criteria for what constitutes a valid repository path
   - Handle both relative and absolute paths consistently

3. **Error Handling**:

   - Fail with clear, actionable error messages
   - No need for complex recovery options
   - Ensure error messages are consistent across different tools

4. **Configuration Integration**:
   - Define a clear schema for `.cursor/mcp.json`
   - Command line arguments should override configuration file
   - Configuration file should override defaults
