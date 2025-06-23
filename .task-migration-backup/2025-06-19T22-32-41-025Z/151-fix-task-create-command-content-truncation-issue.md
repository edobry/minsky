# Task #151: Fix Task Create Command Content Truncation Issue

## Context

The `minsky tasks create` command currently has a significant issue where it does not preserve the full content of the input specification file. Instead of keeping the complete specification with all sections (Requirements, Implementation Details, Acceptance Criteria, Testing Strategy, etc.), the command appears to parse the input and generate a simplified template with generic "TBD" placeholders.

This behavior was observed when creating Task #150, where a comprehensive specification with detailed requirements, implementation code examples, and acceptance criteria was reduced to a basic template with only:

- Title and Context sections preserved
- Requirements section containing only "1. TBD"
- Implementation Steps section containing only "1. [ ] TBD"
- Verification section containing only "- [ ] TBD"

This makes the task creation process unreliable for creating detailed specifications and forces manual editing after creation.

## Background

The `task create` command should preserve the complete content of the input specification file, only adding:

1. The automatically assigned task ID to the title
2. The task entry to `process/tasks.md`
3. File renaming to follow the standard format

It should NOT:

- Parse and reformat the specification content
- Replace detailed sections with "TBD" placeholders
- Truncate or summarize the input content

## Requirements

### 1. Preserve Complete File Content

- The command must preserve the entire content of the input specification file
- All sections should be kept exactly as written (Requirements, Implementation Details, Acceptance Criteria, etc.)
- Only the title should be modified to include the assigned task ID
- No content should be replaced with "TBD" placeholders

### 2. Identify Root Cause

- Investigate the current task creation logic in `src/domain/tasks/taskService.ts`
- Identify where and why content truncation is occurring
- Determine if the issue is in parsing, formatting, or file writing logic

### 3. Fix Content Preservation Logic

- Modify the task creation process to preserve original content
- Ensure only the title line is updated with the task ID
- Maintain all other sections and formatting exactly as provided

### 4. Update Task ID Injection

- The task ID should only be added to the title line (first heading)
- Support both formats: `# Task: Title` → `# Task #XXX: Title`
- Leave all other content completely unchanged

### 5. Test Edge Cases

- Test with specifications containing code blocks, complex formatting
- Test with very long specifications
- Test with specifications containing special characters
- Verify all content types are preserved correctly

### 6. Validate File Operations

- Ensure file renaming works correctly with preserved content
- Verify the renamed file contains the complete original content plus task ID
- Test both relative and absolute input file paths

## Technical Investigation

### Current Implementation Issues

The issue likely stems from one of these areas in the task creation logic:

1. **Content Parsing**: The system may be parsing the markdown content and reconstructing it, losing sections
2. **Template Generation**: The system may be using a template approach that only captures certain sections
3. **Content Formatting**: The formatting logic may be replacing detailed content with placeholders

### Files to Investigate

- `src/domain/tasks/taskService.ts` - Main task creation logic
- `src/domain/tasks/taskBackend.ts` - Backend interface definitions
- `src/domain/tasks/markdownTaskBackend.ts` - Markdown-specific implementation
- `src/domain/tasks/taskCommands.ts` - Command interface functions

### Expected Fix Areas

Based on current code patterns, the fix likely involves:

1. Reading the complete file content as-is
2. Only modifying the first heading line to add the task ID
3. Writing the complete modified content to the new file location
4. Avoiding any content parsing or template reconstruction

## Implementation Steps

1. [ ] **Reproduce the Issue**:

   - Create a test specification with detailed sections
   - Run `minsky tasks create` and document exactly what gets truncated
   - Identify the specific content that gets lost

2. [ ] **Investigate Current Code**:

   - Examine `createTask` method in `MarkdownTaskBackend`
   - Trace the content processing flow
   - Identify where truncation occurs

3. [ ] **Fix Content Processing**:

   - Modify the content processing to preserve all original content
   - Update only the title line with the task ID
   - Remove any template generation that replaces content

4. [ ] **Add Content Preservation Tests**:

   - Test with comprehensive specifications
   - Verify all sections are preserved
   - Test edge cases (code blocks, special formatting)

5. [ ] **Update Error Handling**:

   - Ensure file operations handle complex content correctly
   - Add validation that content is preserved
   - Improve error messages for content-related issues

6. [ ] **Regression Testing**:
   - Test existing task creation scenarios
   - Verify backward compatibility
   - Test with various specification formats

## Acceptance Criteria

- [ ] Complete specification content is preserved during task creation
- [ ] Only the title line is modified to include the task ID
- [ ] All sections (Requirements, Implementation Details, Acceptance Criteria, etc.) remain unchanged
- [ ] Code blocks and complex formatting are preserved exactly
- [ ] File renaming works correctly with preserved content
- [ ] Both simple and complex specifications work correctly
- [ ] Existing task creation functionality remains intact
- [ ] Unit tests cover content preservation scenarios
- [ ] Integration tests verify end-to-end content preservation

## Testing Strategy

### 1. Content Preservation Tests

- Create specifications with various section types
- Verify each section is preserved exactly
- Test with code blocks, lists, tables, and other markdown elements

### 2. Regression Tests

- Test existing simple task creation workflows
- Verify backward compatibility with current task formats
- Test both `# Task: Title` and `# Task #XXX: Title` formats

### 3. Edge Case Testing

- Very long specifications (multiple pages)
- Specifications with special characters and unicode
- Specifications with nested sections and complex formatting
- Binary content detection and rejection

### 4. Integration Testing

- End-to-end task creation workflow
- File operations (read, modify, write, rename)
- Task registry updates with preserved content

## Verification

- [ ] Create a detailed test specification and verify it's preserved completely
- [ ] All unit tests pass
- [ ] Integration tests confirm end-to-end functionality
- [ ] Manual testing with various specification formats
- [ ] No regression in existing task creation workflows
- [ ] Error handling works correctly for edge cases

## Expected Impact

**High Priority**: This is a critical issue that affects the core functionality of task management. The current behavior makes the `tasks create` command unreliable for creating detailed specifications, forcing users to manually recreate lost content.

**Breaking Changes**: None expected - this fix should only improve behavior without changing the API.

**User Experience**: Significantly improved reliability and trust in the task creation process.
