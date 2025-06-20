# Task #038: Make tasks status set prompt for status if not provided

## Context

Currently, the `tasks status set` command requires the user to provide the desired status as a command-line argument. If the status is omitted, the command fails with an error. To improve usability and reduce friction, the command should interactively prompt the user to select a status if it is not provided.

## Requirements

1. **Interactive Prompt**

   - If the user does not provide a status as an argument or option, prompt them interactively to select a status.
   - Present a list of valid statuses (e.g., TODO, IN-PROGRESS, IN-REVIEW, DONE) for selection.
   - Use a CLI prompt library (e.g., @clack/prompts or bun-promptx) for the interactive prompt.

2. **Non-Interactive Mode**

   - If the command is run in a non-interactive environment (e.g., piped input, CI), fail with a clear error if the status is not provided.

3. **User Feedback**

   - Clearly indicate the selected status in the output before applying the change.
   - If the user cancels the prompt, exit without making changes.

4. **Tests**

   - Add or update tests to verify:
     - Prompt appears when status is omitted
     - User can select a status and the change is applied
     - Command fails gracefully in non-interactive mode without a status
     - Proper output and error handling

5. **Documentation**
   - Update help text and documentation to describe the new prompt behavior.

## Implementation Steps

- [x] Update the tasks status set command to prompt for status if not provided
- [x] Add interactive prompt logic
- [x] Handle non-interactive mode gracefully
- [x] Add or update tests
- [x] Update documentation and help text
- [x] Update the changelog

## Verification

- [x] Command prompts for status if not provided
- [x] User can select a status and the change is applied
- [x] Command fails gracefully in non-interactive mode without a status
- [x] Output and error handling are clear
- [x] Documentation is updated

## Work Log

The implementation was completed on May 9, 2025. The following changes were made:

1. Updated the `tasks status set` command to make the status argument optional using Commander.js's `[status]` syntax instead of `<status>`.
2. Implemented interactive prompt using @clack/prompts when no status is provided.
3. Added detection for non-interactive environments using `process.stdout.isTTY`.
4. Added comprehensive tests for the interactive prompt functionality.
5. Updated README.md to document the new feature, including examples.
6. Updated CHANGELOG.md to record the change.

Testing showed that the interactive prompt works as expected in terminal environments. The command also handles non-interactive environments appropriately, showing a clear error message when trying to run without a status.
