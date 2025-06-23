# Task #055: Document and Fix Rule Sync Bug in Minsky CLI

## Objective

Document and resolve the issue where updates to `.cursor/rules/*.mdc` files are not reflected in the Minsky CLI rule system, requiring manual editing and causing potential confusion or process errors.

## Context

Recent attempts to update the `task-status-verification` rule revealed that changes made directly to `.cursor/rules/task-status-verification.mdc` are not shown when using `minsky rules get ...`. This indicates a sync or ingestion bug in the rule management system.

## Requirements

- [ ] Investigate why the Minsky CLI does not reflect updates to rule files.
- [ ] Document the bug and current manual workaround in the rule file.
- [ ] Ensure all rule changes are tracked as tasks per `@creating-tasks.mdc`.
- [ ] Propose or implement a fix so that rule updates are reliably reflected in the CLI.
- [ ] Reference this task in any bug notes or manual edits to affected rule files.

## Implementation Steps

1. [ ] Create this task spec and register it using the Minsky CLI.
2. [ ] Add a bug note to `.cursor/rules/task-status-verification.mdc` referencing this task.
3. [ ] Investigate the rule sync mechanism in the CLI.
4. [ ] Propose or implement a fix.
5. [ ] Verify that rule updates are reflected in the CLI after the fix.
6. [ ] Remove the manual bug note once resolved.

## Verification

- [ ] Rule updates to `.cursor/rules/*.mdc` are immediately visible via `minsky rules get ...`.
- [ ] No further manual editing or bug notes are required.
- [ ] This task is referenced in all related bug documentation until resolved.
