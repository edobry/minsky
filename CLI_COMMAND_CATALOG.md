# CLI Command Catalog for Template Conversion

## Overview

This document catalogs all CLI command patterns found in the current rule files (`.cursor/rules/*.mdc`) that need to be converted to templates supporting both CLI and MCP interfaces.

## Task Management Commands

### Core Task Commands
- `minsky tasks list --json` → `tasks.list` ✅ MAPPED
- `minsky tasks list | grep "relevant-keywords"` → Needs grep integration  
- `minsky tasks get <task-id>` → `tasks.get` ✅ MAPPED
- `minsky tasks get #${id} --json` → `tasks.get` ✅ MAPPED
- `minsky tasks spec <task-id>` → `tasks.spec` ✅ MAPPED
- `minsky tasks create --title "Title" --description "Description"` → `tasks.create` ✅ MAPPED
- `minsky tasks create temp-task-spec.md` → `tasks.create` with file input

### Task Status Commands  
- `minsky tasks status get <task-id>` → `tasks.status.get` ✅ MAPPED
- `minsky tasks status set <task-id> <status>` → `tasks.status.set` ✅ MAPPED
- `minsky tasks status set 039 DONE --session task#039` → Enhanced mapping needed
- `minsky task status set <task-id> IN-REVIEW` → `tasks.status.set` (note: "task" vs "tasks")

### Task Query Patterns
- `minsky tasks list --repo /path/to/repo --json` → Enhanced parameters
- `minsky tasks list --repo /path/to/repo --status TODO --json` → Status filtering
- `minsky tasks get --repo /path/to/repo #001 --json` → Repository context
- `minsky tasks status get --repo /path/to/repo #001` → Repository context
- `minsky tasks status set --repo /path/to/repo #001 DONE` → Repository context
- `minsky tasks list --session feature-session` → Session context
- `minsky tasks status set --session feature-session #001 DONE` → Session context

## Session Management Commands

### Core Session Commands
- `minsky session start --task <task-id>` → `session.start` ✅ MAPPED
- `minsky session start --task <task-id> [session-name]` → Parameter variation
- `minsky session start --description "<description>" [session-name]` → Alternative creation
- `minsky session start --task 067` → Specific ID example
- `minsky session start --description "Implement user authentication"` → Description example
- `minsky session list` → `session.list` ✅ MAPPED
- `minsky session list --json` → `session.list` with JSON output
- `minsky session get <session-name>` → `session.get` ✅ MAPPED
- `minsky session get --task <task-id>` → Alternative lookup method
- `minsky session dir <session-name>` → `session.dir` ✅ MAPPED
- `minsky session dir --task <task-id>` → Alternative directory lookup
- `minsky session delete <session-name>` → `session.delete` ✅ MAPPED

### Session Creation Patterns
- `minsky session start --task 123 feature-session` → Named session with task
- `minsky session start --description "Implement user authentication" auth-feature` → Named session with description
- `minsky session start auth-api --repo https://github.com/org/project.git` → Repository specification
- `minsky session start auth-ui --repo https://github.com/org/project.git` → Repository specification

### Session Operations
- `minsky session pr` → `session.pr` ✅ MAPPED
- `minsky session pr --title "your title"` → PR with title
- `minsky session pr --session my-session --title "your title"` → Session-specific PR
- `minsky session pr --task 123 --title "your title"` → Task-specific PR
- `minsky session pr --title "${title}" --body-path "${path}"` → Full PR creation
- `minsky session pr > PR.md` → Output redirection
- `minsky session commit` → Session commit operation
- `cd $(minsky session dir <session-name>)` → Directory navigation pattern
- `cd $(minsky session dir --task <task-id>)` → Alternative navigation
- `cd $(minsky session dir feature-session)` → Specific example

## Rules Management Commands

### Core Rules Commands
- `minsky rules list` → `rules.list` ✅ MAPPED
- `minsky rules list --json` → `rules.list` with JSON output
- `minsky rules get <n>` → `rules.get` ✅ MAPPED
- `minsky rules get <rule-id>` → Rule lookup
- `minsky rules get user-preferences` → Specific example
- `minsky rules create <n>` → `rules.create` ✅ MAPPED
- `minsky rules create <rule-id>` → Rule creation
- `minsky rules update <n>` → `rules.update` ✅ MAPPED
- `minsky rules update <rule-id>` → Rule update
- `minsky rules update user-preferences --description "User preferences for AI behavior"` → Update with description

## Git Commands

### Git Operations (Note: Many are hidden from MCP)
- `minsky git pr` → `session.pr` (redirected in MCP) ✅ MAPPED
- `minsky git pr --session <session-name> [--branch <branch-name>] --path <repo-path>` → Complex PR creation
- `minsky git pr --path ${path}` → Path-specific PR
- `minsky git approve` → PR approval/merge operation (NEEDS MAPPING)
- `minsky git clone <repo-url>` → Repository cloning (NEEDS MAPPING)
- `minsky git clone <repo-url> --session <session-name>` → Clone with session
- `minsky git branch <branch-name> --session <session-name>` → Branch creation (NEEDS MAPPING)
- `minsky git commit --message "${message}"` → Commit operation (NEEDS MAPPING)
- `minsky git push` → Push operation (NEEDS MAPPING)

## Help and Verification Commands

### Command Discovery
- `minsky --help` → Top-level help
- `minsky <command> --help` → Command-specific help
- `minsky rules --help` → Rules help
- `minsky tasks --help` → Tasks help
- `minsky <command> --help` → Generic help pattern

## Workflow Patterns

### Common Command Sequences
1. **Task Discovery**: `minsky tasks list --json`
2. **Task Status Check**: `minsky tasks status get '#<id>'`
3. **Session Creation**: `minsky session start --task <id>`
4. **Session Navigation**: `cd $(minsky session dir task#<id>)`
5. **PR Creation**: `minsky session pr`
6. **PR Approval**: `minsky git approve`
7. **Status Update**: `minsky tasks status set <id> DONE`

### Parameter Patterns
- **Task ID Formats**: `<task-id>`, `#<id>`, `#${id}`, `task#<id>`
- **Repository Context**: `--repo /path/to/repo`, `--repo <repo-url-or-path>`
- **Session Context**: `--session <session>`, `--session feature-session`
- **Output Format**: `--json` (very common)
- **Force Operations**: `--force` (for deletions, etc.)

## Template Conversion Requirements

### High Priority (Core Workflow)
1. **Task Management**: All task commands (list, get, status, create, spec)
2. **Session Management**: All session commands (start, list, get, dir, pr)
3. **Help Commands**: Command discovery and help patterns

### Medium Priority (Advanced Features)
1. **Rules Management**: Rules CRUD operations
2. **Git Operations**: PR creation, approval, basic git operations
3. **Complex Parameters**: Repository context, session context, filtering

### Low Priority (Edge Cases)
1. **Output Redirection**: `> PR.md` patterns
2. **Shell Integration**: `cd $(...)` patterns
3. **Grep Integration**: Command piping and filtering

## Missing MCP Mappings Identified

### Commands Needing MCP Tool Creation
- `minsky git approve` → Need `session.approve` or `git.approve`
- `minsky git clone` → Need `git.clone` (or document as CLI-only)
- `minsky git branch` → Need `git.branch` (or use session workflows)
- `minsky git commit` → Need `git.commit` (or use session commit)
- `minsky git push` → Need `git.push` (or use session commit)

### Enhanced Parameter Support Needed
- Repository context (`--repo`) for all commands
- Session context (`--session`) for all commands  
- Status filtering (`--status`) for task lists
- Output format control (`--json`) consistently
- Force operations (`--force`) where applicable

## Template Strategy

### Template Approach
1. **Command Helpers**: Use `command(key, description)` for standard commands
2. **Code Blocks**: Use `codeBlock(key, example)` for command examples
3. **Workflow Steps**: Use `workflowStep(step, key, description)` for sequences
4. **Conditional Content**: Use `conditionalSection(content, interfaces)` for interface-specific content
5. **Parameter Documentation**: Use `parameterDoc(key)` for parameter explanations

### Interface Handling
- **CLI Mode**: Generate traditional CLI command references
- **MCP Mode**: Generate MCP tool references with parameter guidance
- **Hybrid Mode**: Support both with preference indication

This catalog provides the foundation for systematic template conversion of all rule content. 
