# Task #127: Fix FastMCP Method Registration Issues

## Problem Analysis

Based on the task description and code inspection, we're facing an issue where FastMCP isn't properly registering method names like `tasks.list` despite the methods being correctly registered through the `CommandMapper`. Even the debug utility that tries to access the internal `_tools` property is unsuccessful in listing the available methods.

The issue appears to be related to one of the following areas:
1. Method name formatting during registration in `CommandMapper`
2. How FastMCP internally stores and looks up method names
3. How JSON-RPC requests are being made to invoke these methods
4. Possible version incompatibility in the FastMCP library

## Implementation Plan

### 1. Investigation Phase

1. Create a minimal test script to isolate the issue
   - Similar to `test-mcp.js` but simplified to focus on the method registration
   - Add more detailed logging to trace method registration and invocation

2. Examine how method names are currently registered in `CommandMapper` 
   - Check the format of method names (prefixing, casing, etc.)
   - Verify that method names are properly passed to FastMCP's `addTool` method

3. Test method invocation format in JSON-RPC calls
   - Try different formats (`tasks.list` vs `mcp.tools.execute` with name parameter)
   - Check if namespacing is handled correctly

4. Review FastMCP documentation and source (if available)
   - Research any known issues with method registration
   - Check if there are any specific requirements or formatting rules for method names

### 2. Implementation Phase

Based on findings, the implementation will focus on one of these approaches:

#### Option A: Fix Method Registration Format
- Modify the `CommandMapper` class to format method names correctly
- Ensure consistent naming patterns for all method types (tasks, sessions, git, etc.)

#### Option B: Adjust JSON-RPC Request Format
- Update the request format in client code to properly access registered methods
- Create utility functions to ensure consistent method invocation

#### Option C: Debug and Fix the FastMCP Integration
- Identify specific incompatibilities or bugs in how Minsky uses FastMCP
- Implement workarounds or patches for fastmcp integration

#### Option D: Upgrade FastMCP (if applicable)
- Check if upgrading to a newer version resolves the issue
- Update any code as needed to accommodate API changes

### 3. Testing Phase

1. Create comprehensive tests for all key MCP methods
   - Test registration of methods using the debug utility
   - Test direct invocation of methods

2. Test with various transport options
   - stdio (default)
   - SSE
   - HTTP Streaming

3. Create integration tests that verify method registration in realistic scenarios
   - Test common workflows (task listing, status updates, etc.)

### 4. Documentation and Error Handling

1. Update documentation for MCP method usage if any changes are made
   - Include examples of correct method invocation
   - Document any limitations or special requirements

2. Enhance error handling for method registration and invocation
   - Add detailed error messages for method not found errors
   - Implement graceful fallbacks when possible

## Implementation Steps

1. Create a branch for the fix
2. Set up detailed test scripts to reproduce and analyze the issue
3. Implement the chosen fix option
4. Add comprehensive tests
5. Update documentation
6. Submit PR with detailed description of changes

## Dependencies

- FastMCP library (version 1.27.4 currently)
- Minsky Command Protocol server implementation
- JSON-RPC standards and requirements 
