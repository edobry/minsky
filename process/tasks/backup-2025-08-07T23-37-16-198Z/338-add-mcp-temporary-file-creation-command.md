# Add MCP temporary file creation command

## Context

The MCP (Model Context Protocol) system needs a command to create temporary files that can be used by external tools and AI systems. This would be useful for:

- Creating temporary files for data exchange between AI systems and Minsky
- Providing a secure way to create temp files with automatic cleanup
- Supporting workflows that need temporary workspace files

Currently, the codebase has robust temporary file utilities (`createRobustTempDir`, `createCleanTempFile`) but these are not exposed via MCP.

## Requirements

### Core Functionality

- ✅ Add new MCP command `files.createTemp` or similar
- ✅ Support customizable filename prefix
- ✅ Support customizable file extension/suffix
- ✅ Support optional initial file content
- ✅ Return the full path to the created temporary file
- ✅ Use existing robust temporary file utilities from `src/utils/tempdir.ts`

### Input Parameters (Zod Schema)

- `prefix` (optional string): Prefix for the temporary filename (default: "mcp-temp-")
- `suffix` (optional string): File extension/suffix (default: ".tmp")
- `content` (optional string): Initial content to write to the file (default: "")
- `description` (optional string): Description for logging/debugging purposes

### Output Format

Return object with:

- `success`: boolean
- `path`: string (full path to created file)
- `filename`: string (just the filename)
- `size`: number (file size in bytes)
- `created`: string (ISO timestamp)

### Error Handling

- Handle filesystem permission errors gracefully
- Provide clear error messages for temp directory access issues
- Validate filename characters to prevent path injection

### Security Considerations

- Use secure temp directory locations
- Validate input parameters to prevent path traversal
- Limit file size/content length to prevent abuse
- Use unique filename generation to prevent conflicts

## Implementation Plan

### 1. Create MCP Command Registration

Add command to the MCP command mapper, likely in:

- `src/adapters/mcp/` directory (create new file or extend existing)
- Register with `commandMapper.addCommand()`

### 2. Command Handler Implementation

- Use existing `createRobustTempDir()` utility from `src/utils/tempdir.ts`
- Leverage `createCleanTempFile()` patterns from test utilities if applicable
- Follow error handling patterns from other MCP commands

### 3. Integration Points

- Add to MCP server startup sequence
- Include in MCP tools listing
- Follow existing MCP command patterns for consistency

### 4. Testing

- Unit tests for command handler
- Integration tests with MCP server
- Error scenario testing (permissions, disk space, etc.)
- Security testing for path injection attempts

## File Locations

**New files to create:**

- `src/adapters/mcp/temp-files.ts` - Command implementation
- `tests/adapters/mcp/temp-files.test.ts` - Tests

**Files to modify:**

- MCP command registration file (determine exact location during implementation)
- Add to MCP tools documentation if applicable

## Usage Example

```typescript
// MCP command call
{
  name: "files.createTemp",
  arguments: {
    prefix: "ai-workspace-",
    suffix: ".json",
    content: '{"status": "initialized"}',
    description: "AI workflow state file"
  }
}

// Expected response
{
  success: true,
  path: "/tmp/minsky-temp/ai-workspace-1703123456789-abc123.json",
  filename: "ai-workspace-1703123456789-abc123.json",
  size: 25,
  created: "2024-01-15T10:30:45.123Z"
}
```

## Notes

- Leverage existing temporary file utilities for consistency
- Follow MCP command patterns established in the codebase
- Consider automatic cleanup mechanisms (though temp files typically clean themselves)
- Ensure cross-platform compatibility (Windows, macOS, Linux)
- Consider rate limiting to prevent abuse if exposed to external systems

## Acceptance Criteria

- [ ] MCP command `files.createTemp` successfully creates temporary files
- [ ] All input parameters work as specified
- [ ] Error handling covers common failure scenarios
- [ ] Response format matches specification
- [ ] Security validations prevent path injection
- [ ] Integration tests pass with MCP server
- [ ] Documentation updated with usage examples
