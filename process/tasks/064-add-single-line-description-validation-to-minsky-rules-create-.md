# Task #064: Add Single-Line Description Validation to `minsky rules create`

## Context
According to the `rule-creation-guidelines`, rule descriptions must be concise and fit on a single line to be effective triggers for the AI. The `minsky rules create` command currently allows multi-line descriptions, which can lead to rules that do not function correctly. Adding validation to the CLI will ensure compliance with the guidelines.

## Requirements
- Modify the `minsky rules create` command to validate the `--description` option.
- The validation should check if the provided description string contains any newline characters.
- If a newline character is found, the command should output an informative error message and exit with a non-zero status code.
- The error message should explain that rule descriptions must be a single line.
- This validation should apply regardless of whether the `--overwrite` flag is used.

## Implementation Steps
- [ ] Locate the implementation of the `minsky rules create` command (likely in `src/commands/rules/create.ts`).
- [ ] Access the value provided for the `--description` option.
- [ ] Implement a check for the presence of newline characters (e.g., `\n`).
- [ ] Add conditional logic to trigger an error if newlines are found.
- [ ] Define the error message for invalid descriptions.
- [ ] Ensure the command exits appropriately on validation failure.
- [ ] Add unit tests for the validation logic, covering single-line, multi-line, and empty descriptions, including the `--overwrite` scenario.
- [ ] Update documentation if necessary.

## Verification
- [ ] Running `minsky rules create` with a description containing newlines results in a validation error.
- [ ] Running `minsky rules create` with a single-line description succeeds.
- [ ] Running `minsky rules create` with the `--overwrite` flag and a multi-line description still results in a validation error.
- [ ] The error message is clear and explains the single-line requirement.
- [ ] All new unit tests for the validation logic pass. 
