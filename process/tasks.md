# TODOs

## How to Use This File

This file tracks work items for the project. Each task follows this format:

```markdown
- [ ] Task Title [#123](tasks/123-task-title.md)
```

## Tasks

- [x] Update session start command to support task IDs [#001](tasks/001-update-session-start-task-id.md)
- [x] Store session repos under per-repo directories and add repoName to session DB [#002](tasks/002-per-repo-session-storage.md)
- [x] Add `init` command to set up a project for Minsky [#003](tasks/003-add-init-command.md)
- [x] Add `--task` option to `session get` command to query sessions by task ID [#004](tasks/004-add-task-option-to-session-get.md)
- [x] Add `git push` command to simplify pushing branches to remote repositories [#005](tasks/005-add-git-push-command.md)
- [x] Add `--quiet` option to `session start` for programmatic output [#006](tasks/006-add-quiet-option-to-session-start.md)
- [x] Add `minsky tasks create` command to create tasks from spec documents [#007](tasks/007-add-tasks-create-command.md)
- [x] Update `tasks list` to default to not-DONE tasks only, add option to show DONE [#008](tasks/008-update-tasks-list-hide-done.md)
- [x] Add `git commit` command to stage and commit changes [#009](tasks/009-add-git-commit-command.md)
- [ ] Enhance `git pr` command to create GitHub PRs and update task status [#010](tasks/010-enhance-git-pr-command.md)
- [x] Fix `git pr` command and add proper tests [#011](tasks/011-fix-git-pr-command-and-add-proper-tests.md)
- [x] Add `session update` command to sync session with main branch [#012](tasks/012-add-session-update-command.md)
- [+] Add Repository Backend Support for Remote Git Repositories [#014](tasks/014-add-repository-backend-support.md)
- [x] Add `session delete` command to remove session repos and records [#015](tasks/015-add-session-delete-command.md)
- [x] Enforce task operations in main workspace [#016](tasks/016-enforce-main-workspace-task-operations.md)
- [x] Support both task ID formats (`000` and `#000`) in any command with `--task` option [#017](tasks/017-support-task-id-format-in-task-option.md)
- [x] Add `--task` option to `session dir` command to query session directories by task ID [#018](tasks/018-add-task-option-to-session-dir.md)
- [x] Implement test suite improvements for better reliability and maintainability [#019](tasks/019-implement-test-suite-improvements.md)
- [x] Add `--task` option to `git pr` command [#020](tasks/020-add-task-option-to-git-pr.md)
- [x] Refactor Large Methods in GitService [#021](tasks/021-refactor-large-methods-in-git-service.md)
- [x] Fix Session Test Failures and Linting Issues [#022](tasks/022-fix-session-test-failures.md)
- [x] Add task specification path to task object [#023](tasks/023-add-task-spec-path-to-task-object.md)
- [x] Fix `session dir` command logic [#024](tasks/024-fix-session-dir-command-logic.md)
- [ ] Add `git approve` command for session PR merging [#025](tasks/025-add-git-approve-command.md)
- [x] Fix task spec paths to use standardized format [#026](tasks/026-fix-task-spec-paths.md)
- [x] Auto-detect Session Context in Session Commands [#027](tasks/027-autodetect-session-in-commands.md)
- [x] Automate Task Status Updates at Key Workflow Points [#028](process/tasks/028-automate-task-status-updates-at-key-workflow-points.md)
- [x] Add `rules` command for managing Minsky rules [#029](process/tasks/029-add-rules-command.md)
- [x] Setup Project Tooling and Automation [#030](process/tasks/030-setup-project-tooling-and-automation.md)
- [x] Add Filter Messages to `tasks list` Command [#031](tasks/031-add-task-filter-messages.md)
- [x] Auto-Rename Task Spec Files in `tasks create` Command [#032](tasks/032-auto-rename-task-spec-files.md)
- [ ] Enhance Minsky Init Command with Additional Rules [#033](tasks/033-enhance-init-command-with-additional-rules.md)
- [x] Add MCP Support to Minsky [#034](process/tasks/034-mcp-support.md)
- [x] Fix Task Creation Workflow to Not Require Task Number in Spec Title [#035](process/tasks/035-task-create-title-workflow-fix.md)
- [x] Improve Task Creation Workflow with Auto-Renaming and Flexible Titles [#036](tasks/036-improve-task-creation-workflow.md)
- [x] Add `session commit` Command to Stage, Commit, and Push All Changes for a Session [#037](tasks/037-session-commit-command.md)
- [x] Make tasks status set prompt for status if not provided [#038](tasks/038-tasks-status-set-prompt.md)
- [x] Interface-Agnostic Command Architecture [#039](process/tasks/039-interface-agnostic-commands.md)
- [x] Add `--task` Option to `session delete` Command [#040](process/tasks/040-add-task-option-to-session-delete-command.md)
- [ ] Write Test Suite for Cursor Rules [#041](process/tasks/041-write-test-suite-for-cursor-rules.md)
- [ ] Update Minsky Rule Descriptions for Improved AI Triggering [#042](process/tasks/042-update-minsky-rule-descriptions-for-improved-ai-triggering.md)
- [x] Add Session Information to Task Details [#043](tasks/043-add-session-information-to-task-details.md)
- [x] Fix Remaining Test Failures in Minsky [#044](process/tasks/044-fix-remaining-test-failures-in-minsky.md)
- [ ] Setup Documentation Tooling [#045](process/tasks/045-setup-documentation-tooling.md)
- [ ] Document Dependency Management Process [#046](process/tasks/046-document-dependency-management-process.md)
- [x] Configure MCP Server in Minsky Init Command [#047](process/tasks/047-configure-mcp-server-in-minsky-init-command.md)
- [-] Establish a Rule Library System [#048](process/tasks/048-establish-a-rule-library-system.md)
- [ ] Implement Session-Scoped MCP Server for Workspace Isolation [#049](process/tasks/049-implement-session-scoped-mcp-server-for-workspace-isolation.md)
- [x] Fix Remaining Test Failures in Minsky [#050](process/tasks/050-fix-remaining-test-failures-in-minsky.md)
- [ ] Add Git Commands to MCP Server [#051](process/tasks/051-add-git-commands-to-mcp-server.md)
- [ ] Add Remaining Task Management Commands to MCP [#052](process/tasks/052-add-remaining-task-management-commands-to-mcp.md)
- [x] Prevent Session Creation Within Existing Sessions [#053](process/tasks/053-prevent-session-creation-within-existing-sessions.md)

- [ ] Restore Full Test Suite for `init` Command [#054](process/tasks/054-restore-full-test-suite-for-init-command.md)

- [ ] Document and Fix Rule Sync Bug in Minsky CLI [#055](process/tasks/055-document-and-fix-rule-sync-bug-in-minsky-cli.md)

- [ ] Explore OCI Artifacts for Rule Distribution [#056](process/tasks/056-explore-oci-artifacts-for-rule-distribution.md)

- [ ] Implement TypeScript-based Rule Authoring System [#057](process/tasks/057-implement-typescript-based-rule-authoring-system.md)

- [ ] Evaluate zod-matter and Zod for Rule Metadata and Validation [#058](process/tasks/058-evaluate-zod-matter-and-zod-for-rule-metadata-and-validation.md)

- [ ] Improve Task ID Permissiveness in Minsky CLI Commands [#059](process/tasks/059-improve-task-id-permissiveness-in-minsky-cli-commands.md)

- [ ] Auto-Detect Current Session/Task in Minsky CLI from Session Workspace [#060](process/tasks/060-auto-detect-current-session-task-in-minsky-cli-from-session-workspace.md)

- [ ] Remove Interactive CLI Tests and Establish Core Testing Principles [#061](process/tasks/061-remove-interactive-cli-tests-and-establish-core-testing-principles.md)

- [x] Add Single-Line Description Validation to `minsky rules create` [#064](process/tasks/064-add-single-line-description-validation-to-minsky-rules-create-.md)
