# Task #124: Add Repository Path Parameter to MCP Server

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

### 1. Update MinskyMCPServerOptions interface and constructor

1. The `src/mcp/server.ts` file needs to be modified to:
   - Add a `repositoryPath` property to the `MinskyMCPServerOptions` interface with proper JSDoc comments
   - Store this repository path in the server instance during construction
   - Add a getter method to access the repository path from outside

2. Implementation details:
   - The `repositoryPath` will be optional in the interface but should have a meaningful default
   - Add validation to ensure the path exists and is a valid directory

### 2. Update MCP Start Command

1. The `src/commands/mcp/index.ts` file needs to be modified to:
   - Add a `--repo <path>` option to the start command with appropriate documentation
   - Set the default to `process.cwd()` if not specified
   - Pass the repository path to the server instance during initialization

2. Implementation details:
   - Update the option parsing in the `startCommand.action()` function
   - Add validation to ensure the path exists before starting the server
   - Include appropriate error handling for invalid paths

### 3. Modify the CommandMapper for Repository Context

1. The `src/mcp/command-mapper.ts` file needs to be modified to:
   - Add a `repositoryPath` property to store the server's repository path
   - Create methods to get and use the repository path in tool execution
   - Add a parameter to all command methods to allow overriding the repository path

2. Implementation details:
   - Update the constructor to accept and store the repository path
   - Create a method to retrieve the repository path
   - Add repository path parameter to all tool registration methods

### 4. Update MCP Tool Implementations

1. The adapter files (`src/adapters/mcp/*.ts`) need to be modified to:
   - Add optional repository path parameters to all tool functions
   - Use the server-level repository path as default if no explicit path is provided
   - Pass the appropriate repository path to the domain functions

2. Implementation details:
   - Begin with the tasks.ts adapter, as it's the most critical for this functionality
   - Add repository path parameter to parameter schemas in each tool registration
   - Ensure domain functions receive the repository path correctly

### 5. Update Documentation

1. The `README-MCP.md` file needs to be updated to:
   - Document the new `--repo` parameter for the `minsky mcp start` command
   - Explain how MCP tools use the repository context
   - Include examples for Cursor configuration in `.cursor/mcp.json`

2. Implementation details:
   - Add a section on repository context in the MCP documentation
   - Include example configurations and use cases

### 6. Add Tests

1. Create new tests and update existing tests to:
   - Test MCP server initialization with and without repository path
   - Test tool execution with default and overridden repository paths
   - Test error scenarios with invalid repository paths

2. Implementation details:
   - Add unit tests for MCP server with repository path
   - Add integration tests for tools using the repository context
   - Test error cases and fallback behavior

## Implementation Steps

1. [ ] Update `MinskyMCPServerOptions` interface to include `repositoryPath`

   - [ ] Add documentation for the new option
   - [ ] Update constructor to store the repository path
   - [ ] Add getter method for repository path access

2. [ ] Modify `mcp start` command to accept repository path

   - [ ] Add `--repo <path>` option with appropriate documentation
   - [ ] Set default to `process.cwd()` if not specified
   - [ ] Pass repository path to server instance
   - [ ] Add validation for repository path

3. [ ] Update command mapper and tool implementations

   - [ ] Add repository path parameter to CommandMapper class
   - [ ] Add methods to retrieve and use repository path
   - [ ] Update task tools to use server-level repository path
   - [ ] Update session, git, and rule tools similarly

4. [ ] Add documentation

   - [ ] Update README-MCP.md with information about repository context
   - [ ] Add examples for Cursor configuration

5. [ ] Add tests for new functionality
   - [ ] Test MCP server initialization with repository path
   - [ ] Test tool execution with and without explicit repository path
   - [ ] Test error handling for invalid repository paths

## Verification

- [ ] MCP server starts correctly with specified repository path
- [ ] MCP tools can find and list tasks without requiring explicit repository path
- [ ] Tools can override the default repository path when needed
- [ ] Error messages are clear and helpful when repository issues occur
- [ ] No regressions in existing MCP functionality
- [ ] Documentation is clear and comprehensive

## Technical Notes and Considerations

1. **Path Resolution**: 
   - Need to ensure all paths are properly resolved (relative to absolute)
   - Handle path normalization consistently

2. **Default Path Strategy**:
   - When no repository path is provided, fall back to `process.cwd()`
   - Consider warning when repository path is missing but not failing outright

3. **Backward Compatibility**:
   - Keep all existing functionality working
   - Ensure tools can still function with explicit paths when needed

4. **Configuration Priority**:
   - Command line arguments should override configuration file
   - Configuration file should override defaults
