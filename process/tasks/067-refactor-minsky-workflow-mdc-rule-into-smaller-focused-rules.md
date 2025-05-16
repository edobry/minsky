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

Refactor `minsky-workflow.mdc` into multiple smaller, focused rules that each address a specific aspect of the workflow, while creating an orchestrator rule that provides an overview and links to these specific rules. Ensure proper cross-referencing between rules to maintain comprehensive guidance.

## Acceptance Criteria

- [ ] Extract content from the current `minsky-workflow.mdc` rule into logical sections
- [ ] Create 5-6 smaller, focused rules that each address a specific aspect of the workflow
- [ ] Create an orchestrator rule that provides an overview of the workflow and links to the specific rules
- [ ] Ensure no information is lost during the refactoring
- [ ] Implement proper cross-referencing between rules using the `mdc:rule-name.mdc` notation
- [ ] Update any cross-references in other rules that point to `minsky-workflow.mdc`
- [ ] Test rule application in different scenarios to ensure guidance is still comprehensive
- [ ] Update all rules using the `minsky rules` command to ensure proper metadata
- [ ] Follow the guidance in `rule-creation-guidelines.mdc` for each new rule
- [ ] Add test cases that can be used with the rule test suite being developed in task #041

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

2. **`minsky-session-management.mdc`**

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

4. **`task-status-protocol.mdc`**

   - **Description**: "Protocol for checking, updating, and verifying task status via Minsky CLI"
   - **Focus**: Task status handling
   - **Content**:
     - Status checking commands
     - Status update procedures
     - Verification steps for status changes
     - Integration with task lifecycle

5. **`pr-preparation-workflow.mdc`**

   - **Description**: "REQUIRED protocol for preparing, creating, and submitting PRs for implemented tasks"
   - **Focus**: PR and commit procedures
   - **Content**:
     - PR description generation
     - Commit procedures
     - Final status updates
     - Checklist for PR readiness

6. **`minsky-workflow-orchestrator.mdc`**
   - **Description**: "REQUIRED entry point for understanding the Minsky workflow system"
   - **Focus**: Overview and linking
   - **Content**:
     - Brief overview of workflow philosophy
     - Clear links to detailed rules by purpose
     - Visual workflow diagram showing rule relationships
     - Brief summary of critical points

### 2. Cross-Referencing Strategy

1. Use consistent cross-reference notation: `mdc:rule-name.mdc`
2. Ensure bi-directional references where appropriate (rules reference each other)
3. Create a "See also" section in each rule that links to related rules
4. In the orchestrator rule, clearly show which rule applies at each workflow stage

### 3. Implementation Steps

1. Extract content from current rule into discrete sections
2. Check for existing rules with overlapping content:
   - If exists: update with relevant content or cross-reference
   - If not: create new rule
3. Create each new rule via `minsky rules create` command with appropriate metadata
4. Create the orchestrator rule that links to the detailed rules
5. Update any cross-references in other rules that point to `minsky-workflow.mdc`
6. Test rule application in different scenarios
7. Add test cases for the rule test suite (task #041)
8. Get feedback and iterate

### 4. Testing Strategy

1. Develop test scenarios for the rule test suite (task #041) that:
   - Test single rule application
   - Test transitions between rules (e.g., going from session creation to task implementation)
   - Test scenarios that should trigger multiple rules
   - Verify the orchestrator rule correctly guides to specific rules

2. Develop test cases that cover:
   - Common workflow patterns
   - Edge cases and error handling
   - Specific command usage scenarios
   - Cross-rule guidance consistency

3. Create test scenarios that can be incorporated into task #041's test suite:
   - User queries about basic tasks/sessions
   - Task implementation scenarios
   - Session navigation scenarios
   - PR creation scenarios

### 5. Rules Creation Commands

```bash
# Create CLI usage rule
minsky rules create minsky-cli-usage --name "Minsky CLI Usage Protocol" --description "REQUIRED guidelines for using the Minsky CLI for all task/session operations" --tags "workflow" "cli" --globs "**/*"

# Create session management rule
minsky rules create minsky-session-management --name "Minsky Session Management Protocol" --description "REQUIRED protocol for starting, re-entering, and managing Minsky sessions" --tags "workflow" "session" --globs "**/*"

# Create task implementation workflow rule
minsky rules create task-implementation-workflow --name "Task Implementation Workflow" --description "REQUIRED workflow for implementing tasks from start to completion" --tags "workflow" "tasks" --globs "**/*"

# Create task status protocol rule
minsky rules create task-status-protocol --name "Task Status Protocol" --description "Protocol for checking, updating, and verifying task status via Minsky CLI" --tags "workflow" "tasks" "status" --globs "**/*"

# Create PR preparation workflow rule
minsky rules create pr-preparation-workflow --name "PR Preparation Workflow" --description "REQUIRED protocol for preparing, creating, and submitting PRs for implemented tasks" --tags "workflow" "pr" "git" --globs "**/*"

# Create orchestrator rule
minsky rules create minsky-workflow-orchestrator --name "Minsky Workflow Overview" --description "REQUIRED entry point for understanding the Minsky workflow system" --tags "workflow" "meta" --globs "**/*" --always-apply true
```

## Related Tasks/Dependencies

- Check if `session-first-workflow.mdc` exists and its content
- Check if `task-status-verification.mdc` exists and its content
- Consider integration with task #041: Write Test Suite for Cursor Rules

## Resources/Links

- Current `minsky-workflow.mdc` rule
- `rules-management.mdc`
- `rule-creation-guidelines.mdc`
- `session-first-workflow.mdc`
- `task-status-verification.mdc`

## Notes

- The refactoring should prioritize clarity and usability while maintaining comprehensive coverage
- Rules should follow "Core Principles" from `rule-creation-guidelines.mdc`: rule follower perspective, concision, modularity, clarity, hierarchy, no duplication
- Each rule should have a precise description that triggers its application in the right context
- The orchestrator rule should provide enough context for users to find the specific rule they need
- Test cases developed should be designed to be incorporated into the rule test suite in task #041
- Cross-referencing between rules is crucial to maintain comprehensive guidance and avoid duplication

## Work Log

- 2024-05-15: Reviewed current minsky-workflow.mdc rule and identified six logical components to extract
- 2024-05-15: Created initial drafts of all six rule files in temp-rules directory
- 2024-05-15: Implemented rule cross-referencing system for navigation between rules
- 2024-05-15: Created the rules in the Minsky system using `minsky rules create`
- 2024-05-15: Fixed cross-references format and resolved formatting issues
- 2024-05-15: Marked original rule as deprecated with references to new rules
- 2024-05-15: Updated CHANGELOG.md with refactoring information
- 2024-05-15: Created PR description
