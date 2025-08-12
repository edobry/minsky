# Fix `minsky tasks create` Verbose Content Extraction Bug

## Context

The `minsky tasks create` command has a bug where it extracts excessive content from task specification files and includes it in the main `process/tasks.md` file, breaking the established one-liner format.

**Problem Observed:**
When creating task #134, the command extracted the entire "Context" section including all bullet points, status updates, and technical details from the spec file and dumped them into the main task list instead of keeping just a simple title and link.

**Expected Behavior:**

- Main tasks.md should contain only one-line entries: `- [ ] Task Title [#ID](path/to/spec.md)`
- All detailed content should remain in the individual spec file
- The command should extract only a brief title/description for the main list

**Current Inconsistent Behavior:**

- Some tasks follow the correct format (e.g., most tasks #001-#133)
- Some tasks have excessive detail in tasks.md (e.g., #130, #131, #134 before manual fix)

## Requirements

### 1. Root Cause Analysis

- [ ] Investigate the `minsky tasks create` command implementation
- [ ] Identify where/how content extraction logic works
- [ ] Determine why some tasks get verbose descriptions while others don't
- [ ] Review the markdown parsing and extraction logic

### 2. Fix Content Extraction Logic

- [ ] Ensure only task title is extracted for the main tasks.md entry
- [ ] Preserve all detailed content in individual spec files
- [ ] Maintain consistent one-liner format across all task entries
- [ ] Handle edge cases in markdown parsing (complex titles, special characters)

### 3. Validation and Testing

- [ ] Test the fixed command with various spec file formats
- [ ] Verify existing tasks.md format is not disrupted
- [ ] Ensure backward compatibility with existing spec files
- [ ] Add test cases for content extraction edge cases

### 4. Clean Up Existing Issues

- [ ] Review tasks.md for other entries with excessive detail (like #130, #131)
- [ ] Standardize all entries to follow the one-liner format
- [ ] Document the expected format for future reference

## Implementation Steps

### Phase 1: Investigation

- [ ] Locate the tasks create command source code
- [ ] Trace the content extraction and markdown generation logic
- [ ] Identify the bug causing verbose content inclusion

### Phase 2: Fix Implementation

- [ ] Modify extraction logic to only capture title/brief description
- [ ] Update markdown formatting to use consistent one-liner format
- [ ] Test fix with various spec file formats

### Phase 3: Cleanup and Documentation

- [ ] Fix any remaining verbose entries in tasks.md
- [ ] Document proper task specification format
- [ ] Add validation to prevent future verbose entries

## Verification

**Success Criteria:**

- [ ] `minsky tasks create` produces only one-line entries in tasks.md
- [ ] All detailed content remains in individual spec files
- [ ] Command works consistently regardless of spec file format
- [ ] All existing task entries follow the same clean format

**Test Cases:**

- [ ] Simple task spec with basic title and description
- [ ] Complex task spec with multiple sections and bullet points
- [ ] Task spec with special characters or formatting
- [ ] Verify no regression in existing functionality

## Technical Notes

**Key Files to Investigate:**

- Source code for `minsky tasks create` command
- Markdown parsing/extraction utilities
- Task list formatting logic
- Content extraction algorithms

**Related Issues:**

- Tasks #130, #131 also show verbose content in tasks.md
- May need to establish format validation rules
- Consider adding linting for task list consistency
