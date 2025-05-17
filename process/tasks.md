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
- [+] Add `git approve` command for session PR merging [#025](tasks/025-add-git-approve-command.md)
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

- [x] Document and Fix Rule Sync Bug in Minsky CLI [#055](process/tasks/055-document-and-fix-rule-sync-bug-in-minsky-cli.md)

- [ ] Explore OCI Artifacts for Rule Distribution [#056](process/tasks/056-explore-oci-artifacts-for-rule-distribution.md)

- [ ] Implement TypeScript-based Rule Authoring System [#057](process/tasks/057-implement-typescript-based-rule-authoring-system.md)

- [ ] Evaluate zod-matter and Zod for Rule Metadata and Validation [#058](process/tasks/058-evaluate-zod-matter-and-zod-for-rule-metadata-and-validation.md)

- [x] Add Centralized Test Mock Utilities [#059](process/tasks/059-add-centralized-test-mock-utilities.md)

- [ ] Implement Automatic Test Linting [#060](process/tasks/060-implement-automatic-test-linting.md)

- [ ] Implement Test Fixture Factory Pattern [#061](process/tasks/061-implement-test-fixture-factory-pattern.md)

- [ ] Improve bun:test TypeScript Declarations [#062](process/tasks/062-improve-bun-test-typescript-declarations.md)

- [ ] Define and Implement Snapshot Testing Strategy [#063](process/tasks/063-define-and-implement-snapshot-testing-strategy.md)

- [x] Add Single-Line Description Validation to `minsky rules create` [#064](process/tasks/064-add-single-line-description-validation-to-minsky-rules-create-.md)

- [x] Fix `minsky rules create/update` Description Quoting Bug [#065](process/tasks/065-fix-minsky-rules-create-update-description-quoting-bug.md)

- [x] Investigate and Fix `minsky rules get --format generic` Inconsistency [#066](process/tasks/066-investigate-and-fix-minsky-rules-get-format-generic-inconsistency.md)

- [x] Refactor `minsky-workflow.mdc` Rule into Smaller, Focused Rules [#067](process/tasks/067-refactor-minsky-workflow-mdc-rule-into-smaller-focused-rules.md)

- [x] AI Guideline: Do Not Over-Optimize Indentation [#068](process/tasks/068-ai-guideline-do-not-over-optimize-indentation.md)

- [x] Improve Task ID Permissiveness in Minsky CLI Commands [#069](process/tasks/069-improve-task-id-permissiveness-in-minsky-cli-commands.md)

- [x] Auto-Detect Current Session/Task in Minsky CLI from Session Workspace [#070](process/tasks/070-auto-detect-current-session-task-in-minsky-cli-from-session-workspace.md)

- [x] Remove Interactive CLI Tests and Establish Core Testing Principles [#071](process/tasks/071-remove-interactive-cli-tests-and-establish-core-testing-principles.md)

- [x] Fix Test Failures and Remaining Linter Errors [#072](process/tasks/072-fix-test-failures-and-remaining-linter-errors.md)

- [ ] Fix Adapter Integration Test Failures [#073](process/tasks/073-fix-adapter-integration-test-failures.md)

- [ ] Implement Auto-Dependency Installation for Session Workspaces [#074](process/tasks/074-implement-auto-dependency-installation-for-session-workspaces.md)

- [x] Fix Minsky Session Delete Command Cleanup [#075](process/tasks/075-fix-minsky-session-delete-command-cleanup.md)

- [x] Complete Interface-Agnostic Architecture Migration [#076](process/tasks/076-complete-interface-agnostic-architecture-migration.md)

- [-] Implement Structured Logging System [#077](process/tasks/077-implement-structured-logging-system.md)

- [x] Fix minsky rules CLI to operate on rules in the current workspace (main or session) [#078](process/tasks/078-fix-minsky-rules-cli-to-operate-on-rules-in-the-current-workspace-main-or-session-.md)

- [-] Revisit GitService Testing Strategy [#079](process/tasks/079-revisit-gitservice-testing-strategy.md)

- [ ] Review Workspace and Repository Path Concepts [#080](process/tasks/080-review-workspace-and-repository-path-concepts.md)

- [ ] Disable Debug Logs Unless Debug Log Level is Explicitly Set [#081](process/tasks/081-disable-debug-logs-unless-debug-log-level-is-explicitly-set.md)

- [ ] Add Context Management Commands [#082](process/tasks/082-add-context-management-commands.md)

- [ ] Fix Bugs in Minsky Rules CLI Command [#083](process/tasks/083-fix-bugs-in-minsky-rules-cli-command.md)
