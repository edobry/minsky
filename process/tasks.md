# TODOs

## How to Use This File

This file tracks work items for the project. Each task follows this format:

```markdown
- [ ] Task Title [#123](tasks/123-task-title.md)
```

## Tasks

- [x] Update session start command to support task IDs [#001](tasks/001-update-session-start.md)
- [ ] Store session repos under per-repo directories and add repoName to session DB [#002](tasks/002-session-repo-dirs.md)
- [ ] Add `init` command to set up a project for Minsky [#003](tasks/003-init-command.md)
- [x] Add `--task` option to `session get` command to query sessions by task ID [#004](tasks/004-session-get-task.md)
- [ ] Add `git push` command to simplify pushing branches to remote repositories [#005](tasks/005-git-push.md)
- [ ] Add `--quiet` option to `session start` for programmatic output [#006](tasks/006-session-start-quiet.md)
- [ ] Add `minsky tasks create` command to create tasks from spec documents [#007](tasks/007-tasks-create.md)
- [ ] Update `tasks list` to default to not-DONE tasks only, add option to show DONE [#008](tasks/008-tasks-list-done.md)
- [ ] Add `git commit` command to stage and commit changes [#009](tasks/009-git-commit.md)
- [ ] Enhance `git pr` command to create GitHub PRs and update task status [#010](tasks/010-git-pr-github.md)
- [ ] Fix `git pr` command and add proper tests [#011](tasks/011-git-pr-fix.md)
- [+] Add `session update` command to sync session with main branch [#012](tasks/012/spec.md)
- [ ] Add Repository Backend Support [#014](mdc:tasks/014-add-repository-backend-support.md)
- [x] Add `session delete` command to remove session repos and records [#015](tasks/015-add-session-delete-command.md)
- [x] Enforce task operations in main workspace [#016](tasks/016-enforce-main-workspace-task-operations.md)
