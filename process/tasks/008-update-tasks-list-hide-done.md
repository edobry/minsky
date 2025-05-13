# Task #008: Update `tasks list` to Default to Not-DONE Tasks Only

## Objective

Improve the usability of the `minsky tasks list` command by hiding completed (DONE) tasks by default, and only showing them when explicitly requested via a CLI option.

## Context

Currently, the `minsky tasks list` command displays all tasks, including those marked as DONE. For most workflows, users are only interested in tasks that are not yet completed. Displaying DONE tasks by default clutters the output and makes it harder to focus on actionable work. This change will make the backlog more actionable by default, while still allowing access to completed tasks when needed.

## Requirements

- The `minsky tasks list` command should, by default, only show tasks whose status is not DONE (i.e., TODO, IN-PROGRESS, IN-REVIEW).
- Add a CLI option (e.g., `--all` or `--show-done`) to allow users to include DONE tasks in the output.
- The new option should work with both standard and JSON output modes.
- Update help text and documentation to reflect the new behavior and option.
- Ensure that filtering is performed in the domain layer, not just in the CLI.
- Add or update tests to cover the new default and the new option.

## Implementation Steps

- [ ] Update the `tasks list` command to filter out DONE tasks by default.
- [ ] Add a CLI option (e.g., `--all` or `--show-done`) to include DONE tasks in the output.
- [ ] Update the domain logic to support filtering by status (if not already present).
- [ ] Update help text and documentation for the command.
- [ ] Add or update tests to verify:
  - [ ] Default output excludes DONE tasks
  - [ ] Output with the new option includes DONE tasks
  - [ ] JSON output respects the new option
- [ ] Verify that the change is documented in the changelog.

## Verification

- [ ] By default, `minsky tasks list` only shows tasks that are not DONE.
- [ ] `minsky tasks list --all` (or `--show-done`) shows all tasks, including DONE.
- [ ] The help text for `minsky tasks list` documents the new behavior and option.
- [ ] Tests pass for both default and new option behaviors.
- [ ] Changelog is updated with a reference to this task spec.
