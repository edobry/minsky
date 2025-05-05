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

- [ ] Update the tasks status set command to prompt for status if not provided
- [ ] Add interactive prompt logic
- [ ] Handle non-interactive mode gracefully
- [ ] Add or update tests
- [ ] Update documentation and help text
- [ ] Update the changelog

## Verification

- [ ] Command prompts for status if not provided
- [ ] User can select a status and the change is applied
- [ ] Command fails gracefully in non-interactive mode without a status
- [ ] Output and error handling are clear
- [ ] Documentation is updated 
