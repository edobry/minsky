# Task #067: Refactor `minsky-workflow.mdc` Rule into Smaller, Focused Rules

## Context

The `minsky-workflow.mdc` rule has evolved to become a comprehensive but unwieldy document covering multiple aspects of the Minsky workflow system. As the project has matured, this rule has accumulated a large amount of information spanning CLI usage, session management, task implementation, status protocols, and PR procedures. Following best practices for cursor rule design, we need to refactor this monolithic rule into smaller, focused rules that are easier to navigate, maintain, and apply correctly.

## Description

The current `minsky-workflow.mdc` cursor rule is too large and covers too many concerns, making it difficult to navigate, understand, and maintain. This task involves breaking it down into smaller, focused rules that follow best practices for cursor rule management while maintaining comprehensive coverage of the Minsky workflow system.

## Problem Statement

The `minsky-workflow.mdc` rule has grown too large and covers multiple distinct concerns:

- CLI usage principles and commands
- Session management operations
- Task implementation workflows
- Status update protocols
- PR and commit procedures

This violates the rule-creation-guidelines principles of modularity, concision, and clarity. Large rules with mixed concerns are harder to understand, maintain, and apply correctly.

## Proposed Solution

Refactor `minsky-workflow.mdc` into multiple smaller, focused rules that each address a specific aspect of the workflow, while creating an orchestrator rule that provides an overview and links to these specific rules.

## Acceptance Criteria

- [ ] Extract content from the current `minsky-workflow.mdc` rule into logical sections
- [ ] Create 3-5 smaller, focused rules that each address a specific aspect of the workflow
- [ ] Create an orchestrator rule that provides an overview of the workflow and links to the specific rules
- [ ] Ensure no information is lost during the refactoring
- [ ] Update any cross-references in other rules that point to `minsky-workflow.mdc`
- [ ] Test rule application in different scenarios to ensure guidance is still comprehensive
- [ ] Update all rules using the `minsky rules` command to ensure proper metadata
- [ ] Follow the guidance in `rule-creation-guidelines.mdc` for each new rule

## Implementation Plan

### 1. Rule Structure

Create the following new rules:

1. **`minsky-cli-usage.mdc`**

   - **Description**: "REQUIRED guidelines for using the Minsky CLI for all task/session operations"
   - **Focus**: CLI general principles, verification checkpoints
   - **Content**:
     - Core principle of CLI-only interaction
     - Command reference (brief with `--help` emphasis)
     - Data integrity warnings
     - Never use direct file access

2. **Update `session-first-workflow.mdc` or create `session-workflow.mdc`**

   - **Description**: "REQUIRED protocol for starting, re-entering, and managing Minsky sessions"
   - **Focus**: Session-specific operations
   - **Content**:
     - Session creation with `--quiet` requirement
     - Re-entering existing sessions
     - Session directory navigation pattern
     - Repository isolation warnings
     - Session cleanup procedures

3. **`task-implementation-workflow.mdc`**

   - **Description**: "REQUIRED workflow for implementing tasks from start to completion"
   - **Focus**: Task implementation stages and completion
   - **Content**:
     - Task verification and setup
     - Implementation steps
     - Work log maintenance
     - Testing requirements
     - Status updates
     - PR preparation
     - Task completion checklist

4. **Update `task-status-verification.mdc` or create `task-status-protocol.mdc`**

   - **Description**: "Protocol for checking, updating, and verifying task status via Minsky CLI"
   - **Focus**: Task status handling
   - **Content**:
     - Status checking commands
     - Status update procedures
     - Verification steps for status changes
     - Integration with task lifecycle

5. **`minsky-workflow-orchestrator.mdc`**
   - **Description**: "REQUIRED entry point for understanding the Minsky workflow system"
   - **Focus**: Overview and linking
   - **Content**:
     - Brief overview of workflow philosophy
     - Clear links to detailed rules by purpose
     - Visual workflow diagram if possible
     - Brief summary of critical points

### 2. Implementation Steps

1. Extract content from current rule into discrete sections
2. Check for existing rules with overlapping content:
   - If exists: update with relevant content
   - If not: create new rule
3. Create each new rule via `minsky rules create` command with appropriate metadata
4. Create the orchestrator rule that links to the detailed rules
5. Update any cross-references in other rules that point to `minsky-workflow.mdc`
6. Test rule application in different scenarios
7. Get feedback and iterate

### 3. Rules Creation Commands

```bash
# Create CLI usage rule
minsky rules create minsky-cli-usage --name "Minsky CLI Usage Protocol" --description "REQUIRED guidelines for using the Minsky CLI for all task/session operations" --tags "workflow" "cli" --globs "**/*"

# Create task implementation workflow rule
minsky rules create task-implementation-workflow --name "Task Implementation Workflow" --description "REQUIRED workflow for implementing tasks from start to completion" --tags "workflow" "tasks" --globs "**/*"

# Create orchestrator rule
minsky rules create minsky-workflow-orchestrator --name "Minsky Workflow Overview" --description "REQUIRED entry point for understanding the Minsky workflow system" --tags "workflow" "meta" --globs "**/*" --always-apply true
```

## Related Tasks/Dependencies

- Check if `session-first-workflow.mdc` exists and its content
- Check if `task-status-verification.mdc` exists and its content

## Resources/Links

- Current `minsky-workflow.mdc` rule
- `rules-management.mdc`
- `rule-creation-guidelines.mdc`

## Notes

- The refactoring should prioritize clarity and usability while maintaining comprehensive coverage
- Rules should follow "Core Principles" from `rule-creation-guidelines.mdc`: rule follower perspective, concision, modularity, clarity, hierarchy, no duplication
- Each rule should have a precise description that triggers its application in the right context
- The orchestrator rule should provide enough context for users to find the specific rule they need
