# Enhance session_read_file tool with line range support to match Cursor's built-in read_file functionality

## Context

## Problem Statement

The current `session_read_file` tool only supports reading entire files, unlike Cursor's built-in `read_file` tool which provides sophisticated line range selection, memory-efficient partial reading, and content summarization. This creates a significant capability gap when agents work in session workspaces.

## Investigation Results

Through reverse engineering of Cursor's built-in `read_file` tool, we identified the following capabilities that need to be replicated:

### Cursor's Built-in `read_file` Parameters:
- `target_file`: File path (relative or absolute)
- `start_line_one_indexed`: Starting line number (1-indexed, inclusive)
- `end_line_one_indexed_inclusive`: Ending line number (1-indexed, inclusive)  
- `should_read_entire_file`: Boolean to read complete file
- `limit`: Number of lines to read (legacy parameter, 250 lines max)
- `offset`: Starting offset (legacy parameter)
- `explanation`: Tool usage explanation

### Cursor's Built-in `read_file` Features:
- ✅ **Line Range Support**: Can read specific sections with precise line numbers
- ✅ **Selective Reading**: Supports offset/limit parameters (250 lines max, 200 lines minimum)
- ✅ **Memory Efficient**: Handles large files by reading only requested sections
- ✅ **Content Summaries**: Provides summaries of omitted content when reading ranges
- ✅ **Flexible Reading**: Can read entire file when needed

### Current `session_read_file` Limitations:
- ❌ **No Line Range Support**: Only accepts `session` and `path` parameters
- ❌ **Always Reads Entire File**: Uses `readFile(resolvedPath, "utf8")` - loads complete content
- ❌ **No Selective Reading**: Cannot specify which parts of a file to read
- ❌ **Memory Intensive**: Will load entire file regardless of size
- ❌ **No Content Summaries**: Cannot provide context about omitted sections

## Requirements

### 1. Enhanced Parameter Schema
Update `session_read_file` to support all Cursor parameters while maintaining session isolation:

```typescript
parameters: z.object({
  session: z.string().describe("Session identifier (name or task ID)"),
  path: z.string().describe("Path to the file within the session workspace"), 
  start_line_one_indexed: z.number().optional().describe("Starting line number (1-indexed, inclusive)"),
  end_line_one_indexed_inclusive: z.number().optional().describe("Ending line number (1-indexed, inclusive)"),
  should_read_entire_file: z.boolean().optional().default(false).describe("Whether to read the entire file"),
  explanation: z.string().optional().describe("One sentence explanation of why this tool is being used")
})
```

### 2. Line Range Reading Implementation
- Implement efficient line-by-line reading without loading entire file into memory
- Support 1-indexed line numbers to match Cursor's convention
- Validate line ranges and provide clear error messages for invalid ranges
- Handle edge cases (empty files, single-line files, out-of-bounds ranges)

### 3. Content Summarization
When reading partial content, provide summaries similar to Cursor:
- Show total line count of file
- Indicate which lines were omitted before/after the selected range
- Provide context about file structure if possible

### 4. Memory Efficiency
- Read only requested lines, not entire file content
- Stream file reading for large files
- Optimize for common use cases (small ranges, file headers/footers)

### 5. Backward Compatibility
- Maintain existing behavior when no line range parameters provided
- Default to reading entire file if `should_read_entire_file` is true
- Preserve all current response format fields

### 6. Response Format Enhancement
Enhance response to include:
```typescript
{
  success: true,
  content: string,           // The actual content read
  path: string,             // Original path parameter
  session: string,          // Session identifier
  resolvedPath: string,     // Resolved absolute path
  totalLines?: number,      // Total lines in file
  linesRead?: {            // Range actually read
    start: number,
    end: number
  },
  omittedContent?: {       // Summary of omitted content
    beforeLines?: number,
    afterLines?: number,
    summary?: string
  }
}
```

## Implementation Notes

### File Location
The main implementation is in `src/adapters/mcp/session-files.ts` lines 94-130.

### Testing Requirements
- Test line range reading with various ranges
- Test memory efficiency with large files
- Test edge cases (empty files, single lines, invalid ranges)
- Test backward compatibility with existing usage
- Verify session workspace isolation is maintained

### Performance Considerations
- Use streaming file reading for large files
- Avoid loading entire file when only reading small ranges
- Optimize for common patterns (reading file headers, specific functions)

## Acceptance Criteria

1. ✅ `session_read_file` supports all parameters that Cursor's `read_file` supports
2. ✅ Line range reading works efficiently without loading entire files
3. ✅ Content summarization provides context about omitted content
4. ✅ Backward compatibility maintained for existing usage
5. ✅ Session workspace isolation preserved
6. ✅ Memory usage optimized for large files
7. ✅ Error handling improved for invalid line ranges
8. ✅ Response format enhanced with line count and range metadata
9. ✅ All tests pass including new line range test cases
10. ✅ Documentation updated to reflect new capabilities

## Impact

This enhancement will:
- **Restore Feature Parity**: Agents can work as efficiently in sessions as in main workspace
- **Improve Performance**: Reduce memory usage when working with large files
- **Enhance User Experience**: Provide same capabilities agents expect from Cursor
- **Enable Advanced Workflows**: Support sophisticated file analysis and editing patterns

## Related Files
- `src/adapters/mcp/session-files.ts` - Main implementation
- `src/adapters/mcp/session-workspace.ts` - Duplicate implementation to update
- `docs/session-workspace-tools.md` - Documentation to update
- Tests to create for line range functionality

## Requirements

## Solution

## Notes
