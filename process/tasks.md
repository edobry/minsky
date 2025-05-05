# TODOs

## How to Use This File

This file tracks work items for the project. Each task follows this format:

```markdown
- [ ] Task Title [#123](tasks/123-task-title.md)
```

## Tasks

- [x] Update session start command to support task IDs [#001](tasks/001-update-session-start-task-id.md)
- [x] Store session repos under per-repo directories and add repoName to session DB [#002](tasks/002-per-repo-session-storage.md)
- [ ] Add `init` command to set up a project for Minsky [#003](tasks/003-add-init-command.md)
- [x] Add `--task` option to `session get` command to query sessions by task ID [#004](tasks/004-add-task-option-to-session-get.md)
- [ ] Add `git push` command to simplify pushing branches to remote repositories [#005](tasks/005-add-git-push-command.md)
- [x] Add `--quiet` option to `session start` for programmatic output [#006](tasks/006-add-quiet-option-to-session-start.md)
- [ ] Add `minsky tasks create` command to create tasks from spec documents [#007](tasks/007-add-tasks-create-command.md)
- [x] Update `tasks list` to default to not-DONE tasks only, add option to show DONE [#008](tasks/008-update-tasks-list-hide-done.md)
- [ ] Add `git commit` command to stage and commit changes [#009](tasks/009-add-git-commit-command.md)
- [ ] Enhance `git pr` command to create GitHub PRs and update task status [#010](tasks/010-enhance-git-pr-command.md)
- [X] Fix `git pr` command and add proper tests [#011](tasks/011-fix-git-pr-command-and-add-proper-tests.md)
- [ ] Add `session update` command to sync session with main branch [#012](tasks/012-add-session-update-command.md)
- [ ] Add Repository Backend Support [#014](tasks/014-add-repository-backend-support.md)
- [x] Add `session delete` command to remove session repos and records [#015](tasks/015-add-session-delete-command.md)
- [x] Enforce task operations in main workspace [#016](tasks/016-enforce-main-workspace-task-operations.md)
- [x] Support both task ID formats (`000` and `#000`) in any command with `--task` option [#017](tasks/017-support-task-id-format-in-task-option.md)
- [x] Add `--task` option to `session dir` command to query session directories by task ID [#018](tasks/018-add-task-option-to-session-dir.md)
- [ ] Implement test suite improvements for better reliability and maintainability [#019](tasks/019-implement-test-suite-improvements.md)
- [ ] Add `--task` option to `git pr` command [#020](tasks/020-add-task-option-to-git-pr.md)
- [ ] Refactor Large Methods in GitService [#021](tasks/021-refactor-large-methods-in-git-service.md)
- [ ] Fix Session Test Failures and Linting Issues [#022](tasks/022-fix-session-test-failures.md)
- [x] Add task specification path to task object [#023](tasks/023-add-task-spec-path-to-task-object.md)
- [x] Fix `session dir` command logic [#024](tasks/024-fix-session-dir-command-logic.md)
- [ ] Add `git approve` command for session PR merging [#025](tasks/025-add-git-approve-command.md)
- [ ] Fix task spec paths to use standardized format [#026](tasks/026-fix-task-spec-paths.md)
- [x] Auto-detect Session Context in Session Commands [#027](tasks/027-autodetect-session-in-commands.md)
- [ ] Setup Project Tooling and Automation [#030](tasks/030-setup-project-tooling-and-automation.md)
- [x] Add Filter Messages to `tasks list` Command [#031](tasks/031-add-task-filter-messages.md)
- [ ] Auto-Rename Task Spec Files in `tasks create` Command [#032](tasks/032-auto-rename-task-spec-files.md)
- [ ] Enhance Minsky Init Command with Additional Rules [#033](tasks/033-enhance-init-command-with-additional-rules.md)

- [ ] Add MCP Support to Minsky [#034](process/tasks/034-mcp-support.md)

- [ ] Fix Task Creation Workflow to Not Require Task Number in Spec Title [#035](process/tasks/035-task-create-title-workflow-fix.md)
