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

## Implementation Steps

1. [ ] Update `MinskyMCPServerOptions` interface to include `repositoryPath`

   - [ ] Add documentation for the new option
   - [ ] Update constructor to store the repository path

2. [ ] Modify `mcp start` command to accept repository path

   - [ ] Add `--repo <path>` option with appropriate documentation
   - [ ] Set default to `process.cwd()` if not specified
   - [ ] Pass repository path to server instance

3. [ ] Update command mapper and tool implementations

   - [ ] Add method to retrieve repository path from server instance
   - [ ] Update task tools to use server-level repository path when available
   - [ ] Update session, git, and rule tools similarly

4. [ ] Add documentation

   - [ ] Update README-MCP.md with information about repository context
   - [ ] Add examples for Cursor configuration

5. [ ] Add tests for new functionality
   - [ ] Test MCP server initialization with repository path
   - [ ] Test tool execution with and without explicit repository path

## Verification

- [ ] MCP server starts correctly with specified repository path
- [ ] MCP tools can find and list tasks without requiring explicit repository path
- [ ] Tools can override the default repository path when needed
- [ ] Error messages are clear and helpful when repository issues occur
- [ ] No regressions in existing MCP functionality
- [ ] Documentation is clear and comprehensive
