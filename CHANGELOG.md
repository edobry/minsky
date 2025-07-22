## [Unreleased]

### Enhanced

- **Task #312: Enhanced session_read_file tool with line range support**
  - Added support for line range parameters matching Cursor's read_file interface
  - Added `start_line_one_indexed`, `end_line_one_indexed_inclusive`, `should_read_entire_file`, and `explanation` parameters
  - Implemented intelligent file size handling with context expansion for small ranges
  - Added content summarization for truncated files showing omitted content
  - Enhanced response format with line count metadata and range information
  - Maintains backward compatibility with existing usage
  - Provides feature parity with Cursor's built-in read_file tool for session workspaces

// ... existing changelog content ...