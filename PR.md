# feat(#038): Add interactive prompting to tasks status set command

## Summary
This PR implements task #038, enhancing the `tasks status set` command to interactively prompt for a status when one is not provided. This improves usability and reduces friction when updating task statuses.

## Motivation & Context
Currently, the `tasks status set` command requires users to explicitly provide a status as a command-line argument. When omitted, the command fails with an error. This change makes the status argument optional and adds an interactive prompt for better user experience.

## Design Approach
We've implemented a solution using the `@clack/prompts` library (already a project dependency) to provide an interactive selection UI. The implementation detects non-interactive environments and fails gracefully with a helpful error message in those cases.

## Key Changes
- Modified the status argument in the `tasks status set` command to be optional using Commander.js's `[status]` syntax
- Added interactive prompt using `@clack/prompts` when status is not provided
- Implemented detection for non-interactive environments using `process.stdout.isTTY`
- Added user feedback by displaying the selected status before applying the change
- Added comprehensive tests for all new functionality
- Updated documentation in README.md and CHANGELOG.md

## Code Examples

Command syntax before:
<pre><code class="language-typescript">
.argument("<task-id>", "ID of the task")
.argument("<status>", `New status (${Object.values(TASK_STATUS).join(", ")})`)
</code></pre>

Command syntax after:
<pre><code class="language-typescript">
.argument("<task-id>", "ID of the task")
.argument("[status]", `New status (${Object.values(TASK_STATUS).join(", ")})`)
</code></pre>

Interactive prompt implementation:
<pre><code class="language-typescript">
// If status is not provided, prompt for it in interactive mode
if (!status) {
  // Check if we're in a non-interactive environment
  if (!process.stdout.isTTY) {
    console.error(`\nStatus is required in non-interactive mode.\nValid options are: ${Object.values(TASK_STATUS).join(", ")}\nExample: minsky tasks status set #001 DONE\n`);
    process.exit(1);
    return;
  }
  
  // Prompt for status using @clack/prompts
  const statusOptions = Object.entries(TASK_STATUS).map(([key, value]) => ({
    value: value,
    label: value
  }));
  
  const currentStatus = await taskService.getTaskStatus(normalizedTaskId);
  
  const statusChoice = await p.select({
    message: `Select new status for task ${normalizedTaskId}:`,
    options: statusOptions,
    initialValue: currentStatus as string || TASK_STATUS.TODO
  });
  
  // Handle cancellation
  if (p.isCancel(statusChoice)) {
    p.cancel("Operation cancelled");
    process.exit(0);
    return;
  }
  
  status = String(statusChoice);
}
</code></pre>

## Breaking Changes
None. The command maintains backward compatibility - providing a status as a command-line argument continues to work as before.

## Testing
- Added unit tests for all new functionality, including:
  - Testing successful status setting with provided status
  - Validating status values
  - Testing interactive prompt behavior when status is omitted
  - Verifying non-interactive environment handling
  - Testing cancellation handling
  - Verifying the prompt uses the current task status as its default value
- Manually tested the interactive functionality in terminal environments
- Verified the command fails gracefully in non-interactive environments

## Documentation
Documentation was updated to reflect the new functionality:
- Updated README.md with examples of both explicit and interactive status setting
- Added the new feature to the CHANGELOG.md
- Updated the command's help text 
