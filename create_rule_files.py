#!/usr/bin/env python3
import os

def create_rule_file(file_path, name, description, content):
    """Create a rule file with proper frontmatter and content."""
    frontmatter = f"""---
name: {name}
description: {description}
globs:
  - "**/*"
alwaysApply: false
---
"""
    with open(file_path, 'w') as f:
        f.write(frontmatter + content)
    print(f"Created {file_path}")

# Create directory if it doesn't exist
rules_dir = ".cursor/rules"
if not os.path.exists(rules_dir):
    os.makedirs(rules_dir)

# Rule 1: minsky-workflow-orchestrator
create_rule_file(
    os.path.join(rules_dir, "minsky-workflow-orchestrator.mdc"),
    "Minsky Workflow Orchestrator",
    "Overview of the Minsky workflow system and entry point to focused workflow rules",
    """# Minsky Workflow System

This rule provides an overview of the Minsky workflow system and serves as an entry point to the more detailed workflow rules. The Minsky workflow has been divided into focused rules to make it easier to understand and follow.

## Core Workflow Rules

The following rules form the complete Minsky workflow system:

1. [**minsky-cli-usage**](mdc:.cursor/rules/minsky-cli-usage.mdc) - Guidelines for using the Minsky CLI for all task and session operations
2. [**minsky-session-management**](mdc:.cursor/rules/minsky-session-management.mdc) - Procedures for creating and managing sessions
3. [**task-implementation-workflow**](mdc:.cursor/rules/task-implementation-workflow.mdc) - Step-by-step process for implementing tasks
4. [**task-status-protocol**](mdc:.cursor/rules/task-status-protocol.mdc) - Procedures for checking and updating task status
5. [**pr-preparation-workflow**](mdc:.cursor/rules/pr-preparation-workflow.mdc) - Guidelines for preparing and submitting PRs

## Fundamental Principle: CLI-Based Workflow

**CRITICAL REQUIREMENT**: ALL task and session management MUST be done through the Minsky CLI, not through direct file system operations. This includes:

- Task listing, status checking, and status updates
- Session creation, navigation, and management
- Task implementation and verification
- PR preparation and submission

## When to Apply These Rules

These workflow rules should be applied:

- When starting work on a new task
- When checking or updating task status
- When creating or managing sessions
- When implementing task requirements
- When preparing pull requests

## Supporting Rules

The Minsky workflow is supported by these additional rules:

- [**session-first-workflow**](mdc:.cursor/rules/session-first-workflow.mdc) - Ensures all implementation work happens in dedicated sessions
- [**creating-tasks**](mdc:.cursor/rules/creating-tasks.mdc) - Guidelines for creating well-structured task specifications
- [**pr-description-guidelines**](mdc:.cursor/rules/pr-description-guidelines.mdc) - Format and content requirements for PR descriptions
- [**rules-management**](mdc:.cursor/rules/rules-management.mdc) - Guidelines for managing Minsky rules
"""
)

# Rule 2: minsky-cli-usage
create_rule_file(
    os.path.join(rules_dir, "minsky-cli-usage.mdc"),
    "Minsky CLI Usage Protocol",
    "REQUIRED protocol for using the Minsky CLI for all task and session operations",
    """# Minsky CLI Usage Protocol

⛔️ **CRITICAL: ALL TASK AND SESSION OPERATIONS MUST USE THE MINSKY CLI**

## Core Principles

1. **Always Use Minsky CLI for Task/Session Data**
   - NEVER use file listings or static documentation for task/session data
   - NEVER directly manipulate Minsky's state files or databases
   - NEVER delete or modify files in `~/.local/state/minsky/`
   - NEVER read or write to `session-db.json` directly - this is STRICTLY FORBIDDEN
   - ALWAYS use appropriate minsky commands (see Command Reference section below)

2. **Use Official Global Installation**
   - Use the globally installed `minsky` CLI (available on your PATH, typically via `bun link`)
   - **Do NOT use `bun run ...` for task/session operations**
   - Only use `bun run ...` or direct script execution when developing or testing the Minsky CLI itself

3. **Data Integrity is Critical**
   - Minsky maintains critical state in `~/.local/state/minsky/`
   - Direct manipulation of these files will corrupt the system
   - NEVER attempt to "fix" issues by deleting state files
   - Deleting state files is STRICTLY FORBIDDEN as it:
     - Corrupts Minsky's understanding of tasks and sessions
     - Makes session management impossible
     - May lead to lost work or inconsistent state
     - Violates the core principle of CLI-based management
"""
)

# Rule 3: minsky-session-management
create_rule_file(
    os.path.join(rules_dir, "minsky-session-management.mdc"),
    "Minsky Session Management Protocol",
    "REQUIRED protocol for starting, re-entering, and managing Minsky sessions",
    """# Minsky Session Management Protocol

**NO IMPLEMENTATION WORK CAN BEGIN WITHOUT AN ACTIVE SESSION**

This rule defines the procedures for creating, navigating, and managing Minsky sessions, which provide isolated workspaces for task implementation.

## What is a Minsky Session?

A Minsky session is an isolated workspace for implementing a specific task. It ensures:

1. **Isolation**: Changes are isolated from the main workspace until they're ready for review
2. **Traceability**: Each session is associated with a specific task
3. **Reproducibility**: Sessions can be recreated or updated as needed
"""
)

# Rule 4: task-implementation-workflow
create_rule_file(
    os.path.join(rules_dir, "task-implementation-workflow.mdc"),
    "Task Implementation Workflow",
    "REQUIRED workflow for implementing tasks from start to completion",
    """# Task Implementation Workflow

This rule provides a detailed, step-by-step process for implementing tasks in the Minsky workflow.

## Task Implementation Lifecycle

### 1. Task Selection

1. **List available tasks**:
   ```bash
   minsky tasks list --json
   ```

2. **View task details**:
   ```bash
   minsky tasks get <task-id>
   ```

3. **Check the current status**:
   ```bash
   minsky tasks status get <task-id>
   ```
"""
)

# Rule 5: task-status-protocol
create_rule_file(
    os.path.join(rules_dir, "task-status-protocol.mdc"),
    "Task Status Protocol",
    "REQUIRED protocol for checking, updating, and verifying task status",
    """# Task Status Protocol

This rule defines the standard protocol for checking, updating, and verifying task status within the Minsky system.

## Task Status Lifecycle

Tasks in the Minsky system progress through the following statuses:

- `TODO`: Not started, available to work on
- `IN-PROGRESS`: Work has begun but is not complete
- `IN-REVIEW`: Work is complete and awaiting review
- `DONE`: Work is complete, reviewed, and merged
"""
)

# Rule 6: pr-preparation-workflow
create_rule_file(
    os.path.join(rules_dir, "pr-preparation-workflow.mdc"),
    "PR Preparation Workflow",
    "REQUIRED workflow for preparing and submitting pull requests",
    """# PR Preparation Workflow

This rule provides guidelines for preparing and submitting pull requests (PRs) in the Minsky workflow.

## PR Creation Process

### 1. Verify Implementation Completeness

Before creating a PR, ensure:

1. **All requirements are implemented**: Check the task specification to confirm all requirements are met
2. **All tests pass**: Run the test suite to ensure all tests pass
3. **Code quality is acceptable**: Check for any linting issues or code smells
4. **Documentation is updated**: Ensure task documentation and changelog are updated
"""
)

print("All rule files created successfully with proper frontmatter.") 
