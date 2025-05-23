# fix(#135): Prevent verbose content extraction in task list

## Summary

This PR implements task #135, fixing a bug where `minsky tasks create` extracted excessive content from task specification files and included it in the main `process/tasks.md` file instead of maintaining the established one-liner format.

## Motivation & Context

The task list in `process/tasks.md` is designed to provide a clean, scannable overview of all tasks using a standardized one-liner format: `- [checkbox] Title [#ID](path)`. However, the `formatTasksToMarkdown` function was incorrectly including task descriptions as indented bullet points, causing verbose content from Context sections and other detailed information to appear in the main task list.

This broke the established pattern and made the task list cluttered and difficult to scan. Tasks #130, #131, and #134 were identified as having this issue, where multiple lines of context and implementation details appeared under their main entries.

The bug was critical because it undermined the core principle of keeping the main task list concise while preserving detailed information in individual specification files.

## Design Approach

The fix focuses on the `formatTasksToMarkdown` function in `src/domain/tasks/taskFunctions.ts`, which is responsible for converting task data objects into markdown format for the main task list.

The original implementation had conditional logic that would append task descriptions as indented list items when descriptions were present. This approach was fundamentally flawed because:

1. **Scope confusion**: Task descriptions are meant for individual spec files, not the main list
2. **Format inconsistency**: Some tasks appeared as one-liners while others had multiple indented lines
3. **Information architecture violation**: The main list should be an index, not a detailed view

The solution removes the description formatting logic entirely, ensuring that `formatTasksToMarkdown` always returns only the essential task line format.

## Key Changes

- **Modified `formatTasksToMarkdown` function**: Removed the conditional logic that added descriptions to main list
- **Simplified return logic**: Function now always returns just the task line: `- [checkbox] Title [#ID](path)`
- **Updated test coverage**: Modified the test to verify that descriptions are NOT included in markdown output
- **Added comprehensive test**: Created test task #136 with verbose content to verify the fix works correctly

### Code Changes

Before (buggy behavior):

<pre><code class="language-typescript">
export function formatTasksToMarkdown(tasks: TaskData[]): string {
  return tasks
    .map((task) => {
      const taskLine = `- [${checkbox}] ${task.title} [${task.id}](${specPath})`;

      if (!task.description) return taskLine;

      // This was the problem - adding descriptions to main list
      const description = task.description
        .split("\n")
        .map((line) => `  - ${line}`)
        .join("\n");

      return `${taskLine}\n${description}`;
    })
    .join("\n\n");
}
</code></pre>

After (fixed behavior):

<pre><code class="language-typescript">
export function formatTasksToMarkdown(tasks: TaskData[]): string {
  return tasks
    .map((task) => {
      const checkbox = STATUS_TO_CHECKBOX[task.status] || " ";
      const specPath = task.specPath || "#";
      const taskLine = `- [${checkbox}] ${task.title} [${task.id}](${specPath})`;

      // Always return only the task line - descriptions remain in spec files
      return taskLine;
    })
    .join("\n\n");
}
</code></pre>

## Breaking Changes

None. This change actually restores the intended behavior and fixes a bug. All existing task entries will now display in the correct one-liner format.

## Testing

### Verification Strategy
1. **Existing test updates**: Modified the `formatTasksToMarkdown` test to verify descriptions are excluded
2. **Integration testing**: Created test task #136 with verbose Context section to verify real-world behavior
3. **Regression testing**: Ran full test suite to ensure no functionality was broken
4. **Manual verification**: Confirmed all tasks (#001-#136) now display in proper one-liner format

### Test Results

    ✓ All 98 task-related tests pass
    ✓ Test task #136 displays correctly as one-liner
    ✓ Main task list is now consistently formatted
    ✓ No regression in task creation, parsing, or status management functionality

### Example Output

Test task #136 with verbose content appears correctly as:

    - [ ] Test Fix in Session Workspace [#136](path/to/spec.md)

Instead of the previous buggy behavior that would include multiple lines of Context content.

## Ancillary Changes

- **Test file improvements**: Updated test descriptions to be more specific about the expected behavior
- **Code comments**: Added clarifying comment about design intention in the fixed function
- **Test fixtures**: Created comprehensive test content to verify edge cases with verbose markdown content

## Verification

The fix has been thoroughly verified:

1. **Historical cleanup**: Existing tasks #130, #131, #134 now display in clean one-liner format
2. **New task verification**: Test task #136 created with verbose content displays correctly
3. **Functional testing**: All task management operations (create, list, update status) work correctly
4. **Format consistency**: All 136 tasks now follow the exact same format pattern

This resolves the verbose content extraction bug completely while maintaining all existing functionality. 
