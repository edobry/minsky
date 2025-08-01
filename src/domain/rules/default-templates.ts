/**
 * Default Rule Templates
 *
 * This module exports the default rule templates used by the template system.
 */

import { type RuleTemplate } from "./rule-template-service";

/**
 * Template for the main Minsky workflow rule
 */
const MINSKY_WORKFLOW_TEMPLATE: RuleTemplate = {
  id: "minsky-workflow",
  name: "Minsky Workflow",
  description: "Core workflow orchestration guide for Minsky",
  tags: ["workflow", "core"],
  generateContent: (context) => {
    const { helpers } = context;
    const isCliMode = context.config.interface === "cli";
    const isMcpMode = context.config.interface === "mcp";
    const isHybridMode = context.config.interface === "hybrid";

    return `# Minsky Workflow

This rule defines the complete workflow for working with tasks and sessions in Minsky.

## Core Workflow Steps

### 1. Task Management
${helpers.conditionalSection(
  isCliMode || isHybridMode,
  `
**List Available Tasks**
\`\`\`bash
${helpers.command("tasks.list")}
\`\`\`
`,
  ""
)}
${helpers.conditionalSection(
  isMcpMode || isHybridMode,
  `
**List Available Tasks (MCP)**
\`\`\`
${helpers.command("tasks.list")}
\`\`\`
`,
  ""
)}

**Get Task Details**
${helpers.conditionalSection(
  isCliMode || isHybridMode,
  `
\`\`\`bash
${helpers.command("tasks.get")}
\`\`\`
`,
  ""
)}
${helpers.conditionalSection(
  isMcpMode || isHybridMode,
  `
\`\`\`
${helpers.command("tasks.get")}
\`\`\`
`,
  ""
)}

**Check Task Status**
${helpers.conditionalSection(
  isCliMode || isHybridMode,
  `
\`\`\`bash
${helpers.command("tasks.status.get")}
\`\`\`
`,
  ""
)}
${helpers.conditionalSection(
  isMcpMode || isHybridMode,
  `
\`\`\`
${helpers.command("tasks.status.get")}
\`\`\`
`,
  ""
)}

### 2. Session Management

**Start New Session**
${helpers.conditionalSection(
  isCliMode || isHybridMode,
  `
\`\`\`bash
${helpers.command("session.start")}
\`\`\`
`,
  ""
)}
${helpers.conditionalSection(
  isMcpMode || isHybridMode,
  `
\`\`\`
${helpers.command("session.start")}
\`\`\`
`,
  ""
)}

**Get Session Directory**
${helpers.conditionalSection(
  isCliMode || isHybridMode,
  `
\`\`\`bash
${helpers.command("session.dir")}
\`\`\`
`,
  ""
)}
${helpers.conditionalSection(
  isMcpMode || isHybridMode,
  `
\`\`\`
${helpers.command("session.dir")}
\`\`\`
`,
  ""
)}

### 3. Implementation Process

1. **Create Session**: Use session.start with task ID
2. **Work in Session**: All code changes happen in the session directory
3. **Regular Commits**: Commit changes frequently
4. **Create PR**: Use session.pr.create when ready for review
5. **Update Status**: Set task status to IN-REVIEW

### 4. Review & Completion

**Create Pull Request**
${helpers.conditionalSection(
  isCliMode || isHybridMode,
  `
\`\`\`bash
${helpers.command("session.pr.create")}
\`\`\`
`,
  ""
)}
${helpers.conditionalSection(
  isMcpMode || isHybridMode,
  `
\`\`\`
${helpers.command("session.pr.create")}
\`\`\`
`,
  ""
)}

**Update Task Status**
${helpers.conditionalSection(
  isCliMode || isHybridMode,
  `
\`\`\`bash
${helpers.command("tasks.status.set")}
\`\`\`
`,
  ""
)}
${helpers.conditionalSection(
  isMcpMode || isHybridMode,
  `
\`\`\`
${helpers.command("tasks.status.set")}
\`\`\`
`,
  ""
)}

## Best Practices

- Always work in sessions for code isolation
- Use descriptive commit messages
- Update task status at key milestones
- Document any architectural decisions
- Test changes before creating PRs

## Command Parameters

${helpers.parameterDoc("tasks.list")}

${helpers.parameterDoc("session.start")}

${helpers.parameterDoc("session.pr.create")}
`;
  },
  generateMeta: (context) => ({
    name: "Minsky Workflow",
    description: "Core workflow orchestration guide for Minsky",
    tags: ["workflow", "core", "required"],
  }),
};

/**
 * Template for the rules index
 */
const INDEX_TEMPLATE: RuleTemplate = {
  id: "index",
  name: "Rules Index",
  description: "Index of all available rules in the workspace",
  tags: ["index", "navigation"],
  generateContent: (context) => {
    const { helpers } = context;

    return `# Minsky Rules Index

This document categorizes all available rules in the Minsky ecosystem, describes their purpose, and identifies which rules apply in different usage scenarios.

## Core Workflow Rules

These rules define the fundamental workflow and processes for using Minsky:

| Rule | Description | When to Apply |
|------|-------------|--------------|
| **minsky-workflow** | Defines the complete workflow for working with tasks and sessions. Includes task selection, status management, implementation process, and PR preparation | **Always required**. Applies to any interaction with tasks or sessions |
| **session-first-workflow** | Enforces that all implementation work happens in dedicated sessions | During all implementation tasks, ensuring code isolation |
| **creating-tasks** | Guidelines for creating well-structured task specifications | When defining new work items or requirements |
| **changelog** | Requirements for maintaining a structured changelog | When completing tasks that modify code |

## Code Organization Rules

These rules ensure consistent organization and structure in the codebase:

| Rule | Description | When to Apply |
|------|-------------|--------------|
| **module-organization** | Enforces separation between business logic and CLI concerns | When designing new modules or features |
| **command-organization** | Standards for structuring CLI commands | When creating new commands or modifying existing ones |
| **domain-oriented-modules** | Promotes organizing code by domain concepts | When designing module structure or refactoring |
| **file-size** | Guidelines for avoiding overly large files | When creating new files or growing existing ones |
| **constants-management** | Best practices for organizing constants | When adding new constants or refactoring existing ones |

## Quality Assurance Rules

These rules enforce quality and robustness in code:

| Rule | Description | When to Apply |
|------|-------------|--------------|
| **robust-error-handling** | Standards for comprehensive error handling | When working with operations that might fail |
| **dont-ignore-errors** | Enforces addressing all errors before considering tasks complete | During implementation and review of any code |
| **tests** | Requirements for test coverage and when to run tests | When modifying code that requires testing |
| **testable-design** | Guidelines for creating easily testable code | When designing new features or components |
| **designing-tests** | Principles for effective test design | When writing or modifying tests |
| **test-expectations** | Best practices for managing test expectations | When updating code that changes expected behavior |
| **test-driven-bugfix** | Process for fixing bugs using test-driven development | When addressing bugs or regressions |
| **cli-testing** | Approaches for testing command-line interfaces | When testing CLI commands or features |
| **testing-session-repo-changes** | Procedures for testing changes in session repositories | When modifying code that affects session repositories |

## Documentation & Communication Rules

These rules ensure clear communication about changes and design:

| Rule | Description | When to Apply |
|------|-------------|--------------|
| **pr-description-guidelines** | Format and content requirements for PR descriptions | When preparing pull requests |
| **rule-creation-guidelines** | Standards for creating or updating rule files | When modifying existing rules or creating new ones |
| **json-parsing** | Best practices for working with JSON output | When implementing commands that output JSON |

## Tooling & Environment Rules

These rules standardize the development environment:

| Rule | Description | When to Apply |
|------|-------------|--------------|
| **bun_over_node** | Mandates using Bun instead of Node.js | For all JavaScript/TypeScript execution and package management |
| **template-literals** | Preference for template literals over string concatenation | When constructing strings with variable content |
| **user-preferences** | Records user preferences from interactions | When implementing features that should respect user preferences |

## Command Reference Quick Guide

### Task Management Commands
- **List tasks**: ${helpers.command("tasks.list")} - query available tasks
- **Get task details**: ${helpers.command("tasks.get")} - retrieve task information
- **Check status**: ${helpers.command("tasks.status.get")} - check task status
- **Update status**: ${helpers.command("tasks.status.set")} - update task status

### Session Management Commands  
- **List sessions**: ${helpers.command("session.list")} - view all sessions
- **Start session**: ${helpers.command("session.start")} - create new session
- **Get session info**: ${helpers.command("session.get")} - retrieve session details
- **Get session directory**: ${helpers.command("session.dir")} - get session path

${helpers.conditionalSection(context.config.interface === "mcp", "mcp,hybrid", "")}

${helpers.conditionalSection(context.config.interface === "cli", "cli,hybrid", "")}

## Usage Scenarios & Applicable Rules

### For New Contributors

When a developer first joins the project, they should focus on:

1. **minsky-workflow** - Understand the overall process
2. **session-first-workflow** - Learn the critical session creation requirements  
3. **creating-tasks** - Know how to document new work
4. **module-organization** & **command-organization** - Understand the codebase structure

### When Implementing Features

During feature implementation, the most relevant rules are:

1. **minsky-workflow** & **session-first-workflow** - Follow the proper process
2. **domain-oriented-modules** & **module-organization** - Structure code correctly
3. **robust-error-handling** & **dont-ignore-errors** - Ensure resilient code
4. **testable-design** & **tests** - Create properly tested features
5. **changelog** - Document the changes

### When Fixing Bugs

For bug fixes, prioritize:

1. **test-driven-bugfix** - Use proper bug-fixing methodology
2. **dont-ignore-errors** - Ensure all errors are handled
3. **test-expectations** - Update tests appropriately
4. **changelog** - Document the fix

### When Reviewing Code

Code reviewers should focus on:

1. **pr-description-guidelines** - Ensure proper documentation
2. **robust-error-handling** & **dont-ignore-errors** - Verify error handling
3. **domain-oriented-modules** & **module-organization** - Check structural alignment
4. **testable-design** & **tests** - Validate test coverage
5. **changelog** - Confirm changes are documented

### When Creating New Rules

When developing new Minsky rules:

1. **rule-creation-guidelines** - Follow the standards for rule creation

### When Setting Up New Projects

For initializing new projects with Minsky:

1. **minsky-workflow** - Establish the core workflow
2. **session-first-workflow** - Enforce proper session usage
3. **creating-tasks** - Enable structured task creation
4. **changelog** - Set up change tracking
5. **module-organization** & **command-organization** - If developing with the same architecture

## Rule Relationships

Some rules are closely related and often used together:

- **module-organization** and **domain-oriented-modules** complement each other for code structuring
- **testable-design**, **designing-tests**, and **tests** form a comprehensive testing approach
- **minsky-workflow** and **session-first-workflow** together define the complete development process
- **robust-error-handling** and **dont-ignore-errors** ensure comprehensive error management
- **pr-description-guidelines** and **changelog** both contribute to documentation of changes

This index serves as a guide to help you understand which rules are relevant to different aspects of working with Minsky and how they interact with each other.`;
  },
  generateMeta: (context) => ({
    name: "Rules Index",
    description: "Index of all available rules in the workspace",
    tags: ["index", "navigation", "overview"],
  }),
};

/**
 * Template for MCP usage rules
 */
const MCP_USAGE_TEMPLATE: RuleTemplate = {
  id: "mcp-usage",
  name: "MCP Usage",
  description: "Guidelines for using the Minsky Control Protocol",
  tags: ["mcp", "protocol"],
  generateContent: (context) => {
    const { helpers, config } = context;

    return `# MCP Usage

This rule outlines the usage of the Minsky Control Protocol (MCP) for AI agent interaction.

## Overview

- **Purpose**: Provides a stable, machine-readable interface for AI agents to interact with the Minsky CLI.
- **Transport**: Can be configured for \`stdio\`, \`sse\`, or \`httpStream\`.
- **Commands**: All shared commands are available via MCP.

## Current Configuration

- **Interface**: ${config.interface}
- **MCP Enabled**: ${config.mcpEnabled ? "Yes" : "No"}
- **Transport**: ${config.mcpTransport}
- **Rule Format**: ${config.ruleFormat}

## Available MCP Tools

### Task Management
- ${helpers.command("tasks.list")} - list all tasks
- ${helpers.command("tasks.get")} - get task by ID
- ${helpers.command("tasks.status.get")} - check task status
- ${helpers.command("tasks.status.set")} - update task status
- ${helpers.command("tasks.create")} - create new task

### Session Management
- ${helpers.command("session.list")} - list all sessions
- ${helpers.command("session.get")} - get session details
- ${helpers.command("session.start")} - create new session
- ${helpers.command("session.dir")} - get session directory
- ${helpers.command("session.pr.create")} - create pull request

### Rules Management
- ${helpers.command("rules.list")} - list all rules
- ${helpers.command("rules.get")} - get rule by ID
- ${helpers.command("rules.create")} - create new rule
- ${helpers.command("rules.update")} - update existing rule

## Usage Examples

### Task Management Example
\`\`\`
${helpers.command("tasks.list")}
${helpers.codeBlock(`taskId: "#123"\\n${helpers.command("tasks.get")}`, "bash")}
\`\`\`

### Session Management Example  
\`\`\`
${helpers.codeBlock(`task: "#123"\\n${helpers.command("session.start")}`, "bash")}
${helpers.codeBlock(`name: "task#123"\\n${helpers.command("session.dir")}`, "bash")}
\`\`\`

## Parameter Documentation

${helpers.parameterDoc("tasks.list")}

${helpers.parameterDoc("session.start")}

${helpers.conditionalSection(config.interface === "hybrid", "hybrid", "")}

See README-MCP.md for detailed protocol specifications.`;
  },
  generateMeta: (context) => ({
    name: "MCP Usage",
    description: "Guidelines for using the Minsky Control Protocol",
    tags: ["mcp", "protocol", "ai"],
  }),
};

// Remove duplicate - DEFAULT_TEMPLATES is defined at the end of file

/**
 * Template for Minsky Workflow Orchestrator
 */
const MINSKY_WORKFLOW_ORCHESTRATOR_TEMPLATE: RuleTemplate = {
  id: "minsky-workflow-orchestrator",
  name: "Minsky Workflow Orchestrator",
  description:
    "REQUIRED entry point for understanding the Minsky workflow system including the git approve command for PR merging",
  tags: ["workflow", "orchestrator", "core"],
  generateContent: (context) => {
    const { helpers } = context;

    return `# Minsky Workflow System

This rule provides an overview of the Minsky workflow system and serves as an entry point to the more detailed workflow rules. The Minsky workflow has been divided into focused rules to make it easier to understand and follow.

## Core Workflow Rules

The following rules form the complete Minsky workflow system:

1. [**minsky-cli-usage**](mdc:.cursor/rules/minsky-cli-usage.mdc) - Guidelines for using the Minsky CLI for all task and session operations
2. [**minsky-session-management**](mdc:.cursor/rules/minsky-session-management.mdc) - Procedures for creating and managing sessions  
3. [**task-implementation-workflow**](mdc:.cursor/rules/task-implementation-workflow.mdc) - Step-by-step process for implementing tasks
4. [**task-status-protocol**](mdc:.cursor/rules/task-status-protocol.mdc) - Procedures for checking and updating task status
5. [**pr-preparation-workflow**](mdc:.cursor/rules/pr-preparation-workflow.mdc) - Guidelines for preparing and submitting PRs

## Fundamental Principle: Command-Based Workflow

**CRITICAL REQUIREMENT**: ALL task and session management MUST be done through the appropriate interface commands, not through direct file system operations. This includes:

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
- When approving and merging pull requests

## Workflow Sequence

1. **Task Selection and Status Verification**
   - First: Check available tasks with ${helpers.command("tasks.list")}
   - Then: Verify task status with ${helpers.command("tasks.status.get")}
   - Apply: minsky-cli-usage and task-status-protocol

2. **Session Creation and Navigation**
   - First: Create or re-enter a session for the task
   - Then: Navigate to the session directory
   - Apply: minsky-session-management

3. **Task Implementation**
   - First: Understand task requirements
   - Then: Implement the solution in the session workspace
   - Apply: task-implementation-workflow and session-first-workflow

4. **Testing and Verification**
   - First: Write and run tests for the implementation
   - Then: Verify that all requirements are met
   - Apply: task-implementation-workflow and tests

5. **PR Preparation and Submission**
   - First: Generate PR description
   - Then: Finalize changes and update task status
   - Apply: pr-preparation-workflow

6. **PR Approval and Merging**
   - First: Review PR content thoroughly
   - Then: Use the git approve command to merge the PR branch
   - Apply: pr-preparation-workflow

7. **Task Completion**
   - First: Update task status to DONE after PR is merged
   - Then: Clean up the session if needed
   - Apply: task-status-protocol and minsky-session-management

## Common Workflow Questions

### Task-Related Questions

- **"What tasks are available?"**
  → Apply minsky-cli-usage and use ${helpers.command("tasks.list")}

- **"How do I start working on a task?"**
  → Apply minsky-session-management to create a session

- **"How do I check task status?"**
  → Apply task-status-protocol and use ${helpers.command("tasks.status.get")}

### Session-Related Questions

- **"How do I create a session?"**
  → Apply minsky-session-management and use ${helpers.command("session.start")}

- **"How do I get back to my session?"**
  → Apply minsky-session-management and use ${helpers.command("session.dir")}

- **"Why aren't my changes showing up?"**
  → Apply session-first-workflow to verify you're in the correct workspace

### Implementation Questions

- **"How do I implement a task?"**
  → Apply task-implementation-workflow for step-by-step guidance

- **"How do I verify my implementation?"**
  → Apply task-implementation-workflow and tests

- **"How do I create a PR?"**
  → Apply pr-preparation-workflow for PR creation steps

- **"How do I approve and merge a PR?"**
  → Apply pr-preparation-workflow and use the git approve command to merge the PR

## Error Recovery Checkpoints

| Error Scenario | Rule to Apply | Recovery Action |
|----------------|---------------|-----------------|
| **Wrong Command** | minsky-cli-usage | Check command reference and retry |
| **Path Resolution Issue** | session-first-workflow | Use absolute paths in session workspace |
| **File Editing Outside Session** | session-first-workflow | Cancel edits and switch to session workspace |
| **Status Tracking Issue** | task-status-protocol | Verify implementation state vs. tracked status |
| **PR Creation Problem** | pr-preparation-workflow | Check prerequisites and retry |
| **PR Approval Failure** | pr-preparation-workflow | Address merge conflicts or PR issues before retry |

## Rule Integration Table

| Rule | Primary Purpose | Integrates With |
|------|-----------------|----------------|
| minsky-cli-usage | Command usage | All workflow rules |
| minsky-session-management | Session operations | session-first-workflow, task-implementation-workflow |
| task-implementation-workflow | Task implementation | task-status-protocol, pr-preparation-workflow |
| task-status-protocol | Status management | task-status-verification, task-implementation-workflow |
| pr-preparation-workflow | PR preparation | task-implementation-workflow, pr-description-guidelines |
| session-first-workflow | File operations | minsky-session-management, task-implementation-workflow |

## Supporting Rules

The Minsky workflow is supported by these additional rules:

- [**session-first-workflow**](mdc:.cursor/rules/session-first-workflow.mdc) - Ensures all implementation work happens in dedicated sessions
- [**creating-tasks**](mdc:.cursor/rules/creating-tasks.mdc) - Guidelines for creating well-structured task specifications
- [**pr-description-guidelines**](mdc:.cursor/rules/pr-description-guidelines.mdc) - Format and content requirements for PR descriptions
- [**rules-management**](mdc:.cursor/rules/rules-management.mdc) - Guidelines for managing Minsky rules`;
  },
  generateMeta: (context) => ({
    name: "Minsky Workflow Orchestrator",
    description:
      "REQUIRED entry point for understanding the Minsky workflow system including the git approve command for PR merging",
    alwaysApply: false,
  }),
};

/**
 * Template for Task Implementation Workflow
 */
const TASK_IMPLEMENTATION_WORKFLOW_TEMPLATE: RuleTemplate = {
  id: "task-implementation-workflow",
  name: "Task Implementation Workflow",
  description: "Comprehensive workflow for implementing tasks from creation to completion",
  tags: ["task", "implementation", "workflow"],
  generateContent: (context) => {
    const { helpers } = context;

    return `# Task Implementation Workflow

This rule provides a comprehensive workflow for implementing tasks from start to completion, including all required status updates and checkpoints.

## Prerequisites

Before starting any task implementation, ensure:

1. **Task exists and is properly specified** - Use ${helpers.command("tasks.get")} to verify
2. **Task status is appropriate** - Check with ${helpers.command("tasks.status.get")} 
3. **You understand the requirements** - Review task specification thoroughly

## Implementation Workflow

### Phase 1: Task Preparation

1. **Verify Task Status**
   - Check current status: ${helpers.command("tasks.status.get")}
   - Ensure task is in appropriate state for implementation
   - If not in correct state, update: ${helpers.command("tasks.status.set")}

2. **Create or Resume Session**
   - Check existing sessions: ${helpers.command("session.list")}
   - Create new session: ${helpers.command("session.start")}
   - Get session directory: ${helpers.command("session.dir")}

3. **Set Task Status to IN-PROGRESS**
   - Update status: ${helpers.command("tasks.status.set")} with status "IN-PROGRESS"
   - This signals that active work has begun

### Phase 2: Implementation

1. **Navigate to Session Workspace**
   - Use session directory from previous step
   - Verify you're in the correct workspace
   - All implementation must happen in session workspace

2. **Implement Requirements**
   - Follow task specification exactly
   - Write comprehensive tests for new functionality
   - Ensure all existing tests continue to pass
   - Document any design decisions or trade-offs

3. **Continuous Verification**
   - Run tests frequently during development
   - Check that requirements are being met
   - Address any issues immediately

### Phase 3: Completion Verification

1. **Final Testing**
   - Run complete test suite
   - Verify all new functionality works as specified
   - Ensure no regressions have been introduced

2. **Requirements Review**
   - Review original task specification
   - Confirm all requirements have been addressed
   - Check for any overlooked aspects

3. **Code Quality Check**
   - Review code for clarity and maintainability
   - Ensure proper error handling
   - Verify documentation is complete

### Phase 4: PR Preparation

1. **Update Task Status to IN-REVIEW**
   - Set status: ${helpers.command("tasks.status.set")} with status "IN-REVIEW"
   - This indicates implementation is complete and ready for review

2. **Create Pull Request**
   - Generate PR using session PR command: ${helpers.command("session.pr.create")}
   - Ensure PR description follows guidelines
   - Include task ID in PR title and description

3. **Final Verification**
   - Review PR content thoroughly
   - Ensure all changes are included
   - Verify task status is correctly updated

## Status Transition Protocol

| Current Status | Action Required | Command | Next Status |
|----------------|-----------------|---------|-------------|
| TODO | Start implementation | ${helpers.command("tasks.status.set")} | IN-PROGRESS |
| IN-PROGRESS | Complete implementation | ${helpers.command("tasks.status.set")} | IN-REVIEW |
| IN-REVIEW | Merge PR | Approve PR | DONE |
| BLOCKED | Resolve blocking issue | ${helpers.command("tasks.status.set")} | IN-PROGRESS |

## Quality Gates

Before moving to the next phase, ensure:

### Before IN-PROGRESS → IN-REVIEW
- [ ] All requirements implemented
- [ ] All tests passing
- [ ] Code quality acceptable
- [ ] Documentation complete

### Before IN-REVIEW → DONE  
- [ ] PR created and properly described
- [ ] All feedback addressed
- [ ] Changes approved by reviewer
- [ ] PR merged successfully

## Common Issues and Solutions

### Implementation Issues

**Problem**: Requirements unclear or ambiguous
**Solution**: Update task specification before continuing, don't guess at requirements

**Problem**: Tests failing after changes
**Solution**: Fix tests immediately, don't accumulate technical debt

**Problem**: Scope creep during implementation
**Solution**: Create separate tasks for additional work, stay focused on current task

### Status Management Issues

**Problem**: Forgot to update task status
**Solution**: Check status regularly with ${helpers.command("tasks.status.get")}, update as needed

**Problem**: Task status doesn't match actual progress
**Solution**: Align status with actual state immediately using ${helpers.command("tasks.status.set")}

### Session Management Issues

**Problem**: Working in wrong directory
**Solution**: Always verify you're in session workspace before making changes

**Problem**: Changes not appearing in session
**Solution**: Ensure you created session properly and are in correct directory

## Integration with Other Rules

This workflow integrates with:

- **task-status-protocol**: For detailed status management procedures
- **session-first-workflow**: For session creation and navigation requirements
- **pr-preparation-workflow**: For PR creation and submission details
- **minsky-workflow-orchestrator**: For overall workflow context
- **tests**: For testing requirements and procedures

## Verification Checklist

Use this checklist to ensure proper workflow adherence:

- [ ] Task status checked and appropriate for implementation
- [ ] Session created and verified
- [ ] Task status updated to IN-PROGRESS at start
- [ ] All implementation done in session workspace  
- [ ] Requirements thoroughly implemented
- [ ] Tests written and passing
- [ ] Task status updated to IN-REVIEW when complete
- [ ] PR created with proper description
- [ ] Task linked to PR appropriately`;
  },
  generateMeta: (context) => ({
    name: "Task Implementation Workflow",
    description: "Comprehensive workflow for implementing tasks from creation to completion",
    tags: ["task", "implementation", "workflow", "status"],
  }),
};

/**
 * Template for Session Management
 */
const MINSKY_SESSION_MANAGEMENT_TEMPLATE: RuleTemplate = {
  id: "minsky-session-management",
  name: "Minsky Session Management",
  description: "Complete guide for creating, managing, and working with Minsky sessions",
  tags: ["session", "management", "workflow"],
  generateContent: (context) => {
    const { helpers } = context;

    return `# Minsky Session Management

This rule provides comprehensive guidance for creating, managing, and working with Minsky sessions.

## Overview

Sessions provide isolated development environments for working on specific tasks. Each session:

- Contains a separate git branch and workspace
- Maintains isolation from other work
- Tracks association with specific tasks
- Enables safe experimentation and development

## Session Commands

### Core Session Operations

**List all sessions**: ${helpers.command("session.list")}
- Shows all available sessions with their status and associated tasks

**Get session details**: ${helpers.command("session.get")}
- Retrieves detailed information about a specific session
- Can query by session name or task ID

**Create new session**: ${helpers.command("session.start")}
- Creates a new session for a task
- Automatically sets up isolated workspace and git branch

**Get session directory**: ${helpers.command("session.dir")}
- Returns the absolute path to the session's workspace
- Essential for navigating to the correct working directory

### Advanced Session Operations

**Update session**: ${helpers.command("session.update")}
- Brings session up to date with latest changes from main branch
- Handles merge conflicts and branch synchronization

**Create pull request**: ${helpers.command("session.pr.create")}
- Creates a pull request from the session branch
- Integrates with task management and status updates

**Delete session**: ${helpers.command("session.delete")}
- Removes session workspace and branch
- Use with caution - this is destructive

## Session Lifecycle

### 1. Session Creation

Before starting work on any task:

1. **Verify task exists**: ${helpers.command("tasks.get")}
2. **Check for existing session**: ${helpers.command("session.list")}
3. **Create session if needed**: ${helpers.command("session.start")}
4. **Navigate to session**: Use ${helpers.command("session.dir")} output

Example workflow:
\`\`\`bash
# Check if session already exists for task
${helpers.codeBlock(helpers.command("session.list"))}

# Create session for task #123 if it doesn't exist
${helpers.codeBlock(helpers.command("session.start"))}

# Get session directory and navigate
${helpers.codeBlock(helpers.command("session.dir"))}
\`\`\`

### 2. Working in Sessions

**Critical Requirements**:
- ALL implementation work MUST happen in the session workspace
- Always verify your current directory before making changes
- Never edit files in the main workspace when implementing tasks

**Navigation Pattern**:
1. Get session directory: ${helpers.command("session.dir")}
2. Navigate to that directory
3. Verify you're in the correct location
4. Begin implementation work

### 3. Session Maintenance

**Keep session updated**:
- Regularly sync with main branch: ${helpers.command("session.update")}
- Resolve any merge conflicts promptly
- Push changes frequently to avoid data loss

**Monitor session status**:
- Check session information: ${helpers.command("session.get")}
- Verify task association is correct
- Ensure git branch is properly managed

### 4. Session Completion

When task implementation is complete:

1. **Final verification in session**:
   - Ensure all changes are committed
   - Run final tests in session workspace
   - Verify requirements are fully met

2. **Create pull request**: ${helpers.command("session.pr.create")}
   - Generates PR from session branch
   - Links PR to associated task
   - Updates task status appropriately

3. **Post-merge cleanup**:
   - Session can be deleted after successful merge
   - Or kept for reference if needed

## Session Best Practices

### Directory Management

**Always verify location**:
- Use \`pwd\` to confirm current directory
- Session workspaces are completely separate from main workspace
- Changes in main workspace don't affect session workspace

**Use absolute paths**:
- Get full session path: ${helpers.command("session.dir")}
- Store this path for easy navigation
- Avoid relative path assumptions

### Git Management

**Branch isolation**:
- Each session has its own git branch
- Never work directly on main branch
- Session branches are automatically managed

**Commit frequently**:
- Make small, logical commits
- Push changes regularly
- Use descriptive commit messages

### Task Association

**Maintain task linkage**:
- Sessions are tied to specific tasks
- Verify task association: ${helpers.command("session.get")}
- Don't work on multiple tasks in one session

**Status synchronization**:
- Session operations can update task status
- Monitor status changes: ${helpers.command("tasks.status.get")}
- Ensure status reflects actual progress

## Common Session Scenarios

### Scenario 1: Starting Fresh Task

\`\`\`bash
# 1. Verify task exists and get details
${helpers.command("tasks.get")}

# 2. Create session for the task  
${helpers.command("session.start")}

# 3. Navigate to session workspace
cd \$(${helpers.command("session.dir")})

# 4. Begin implementation
\`\`\`

### Scenario 2: Resuming Existing Work

\`\`\`bash
# 1. Check existing sessions
${helpers.command("session.list")}

# 2. Get session directory
${helpers.command("session.dir")}

# 3. Navigate and continue work
cd \$(${helpers.command("session.dir")})
\`\`\`

### Scenario 3: Updating Session

\`\`\`bash
# 1. Ensure you're in session directory
cd \$(${helpers.command("session.dir")})

# 2. Update session with latest changes
${helpers.command("session.update")}

# 3. Resolve any conflicts if needed
\`\`\`

### Scenario 4: Creating Pull Request

\`\`\`bash
# 1. Verify all changes committed in session
cd \$(${helpers.command("session.dir")})

# 2. Create pull request from session
${helpers.command("session.pr.create")}
\`\`\`

## Troubleshooting

### Problem: Can't find session directory
**Solution**: Use ${helpers.command("session.dir")} to get exact path, don't guess

### Problem: Changes not appearing
**Solution**: Verify you're in session workspace, not main workspace

### Problem: Git conflicts during update
**Solution**: Follow conflict resolution process, commit resolution

### Problem: Session seems corrupted
**Solution**: Check session status with ${helpers.command("session.get")}, consider recreating if necessary

## Integration Points

This rule integrates with:

- **task-implementation-workflow**: For complete task implementation process
- **session-first-workflow**: For the requirement that all implementation happens in sessions
- **pr-preparation-workflow**: For creating PRs from sessions
- **task-status-protocol**: For status updates during session operations`;
  },
  generateMeta: (context) => ({
    name: "Minsky Session Management",
    description: "Complete guide for creating, managing, and working with Minsky sessions",
    tags: ["session", "management", "git", "workspace"],
  }),
};

/**
 * Template for Task Status Protocol
 */
const TASK_STATUS_PROTOCOL_TEMPLATE: RuleTemplate = {
  id: "task-status-protocol",
  name: "Task Status Protocol",
  description:
    "Procedures for checking and updating task status throughout the implementation lifecycle",
  tags: ["task", "status", "protocol"],
  generateContent: (context) => {
    const { helpers } = context;

    return `# Task Status Protocol

This rule defines the procedures for checking and updating task status throughout the implementation lifecycle.

## Status Values

Minsky uses the following task status values:

| Status | Meaning | When to Use |
|--------|---------|-------------|
| **TODO** | Task ready for implementation | Initial state for new tasks |
| **IN-PROGRESS** | Implementation actively underway | When starting implementation work |
| **IN-REVIEW** | Implementation complete, awaiting review | When submitting PR for review |
| **DONE** | Task fully completed and merged | After successful PR merge |
| **BLOCKED** | Implementation blocked by external factor | When unable to proceed |
| **CLOSED** | Task cancelled or no longer needed | When abandoning task |

## Status Commands

### Checking Status

**Get current status**: ${helpers.command("tasks.status.get")}
- Returns current status of specified task
- Essential before starting any work
- Use to verify status is appropriate for next action

**List tasks by status**: ${helpers.command("tasks.list")} with status filter
- Shows all tasks matching specific status
- Useful for finding work to do or reviewing progress

### Updating Status

**Set new status**: ${helpers.command("tasks.status.set")}
- Updates task to new status value
- Include reason/comment when helpful
- Always verify update was successful

## Status Transition Rules

### TODO → IN-PROGRESS
**When**: Starting implementation work
**Trigger**: Creating session and beginning implementation
**Command**: ${helpers.command("tasks.status.set")} with status "IN-PROGRESS"
**Requirements**: 
- Task specification is clear and complete
- Session has been created for the task
- You are ready to begin implementation

### IN-PROGRESS → IN-REVIEW  
**When**: Implementation complete, ready for review
**Trigger**: Creating pull request
**Command**: ${helpers.command("tasks.status.set")} with status "IN-REVIEW"
**Requirements**:
- All requirements implemented
- Tests written and passing
- PR created and properly described

### IN-REVIEW → DONE
**When**: Pull request approved and merged
**Trigger**: Successful PR merge
**Command**: Usually automatic, but can manually set with ${helpers.command("tasks.status.set")}
**Requirements**:
- PR has been reviewed and approved
- All tests passing in CI
- PR successfully merged to main branch

### Any Status → BLOCKED
**When**: Unable to proceed due to external factors
**Trigger**: Encountering blocking dependency or issue
**Command**: ${helpers.command("tasks.status.set")} with status "BLOCKED"
**Requirements**:
- Document the blocking factor
- Identify resolution path if possible
- Notify relevant stakeholders

### BLOCKED → IN-PROGRESS
**When**: Blocking issue resolved
**Trigger**: External dependency resolved or issue fixed
**Command**: ${helpers.command("tasks.status.set")} with status "IN-PROGRESS"
**Requirements**:
- Blocking factor has been resolved
- Implementation can proceed normally

### Any Status → CLOSED
**When**: Task no longer needed or cancelled
**Trigger**: Change in requirements or priorities
**Command**: ${helpers.command("tasks.status.set")} with status "CLOSED"
**Requirements**:
- Clear reason for closure
- Any partial work properly documented

## Status Verification Protocol

### Before Starting Work

1. **Check current status**: ${helpers.command("tasks.status.get")}
2. **Verify status is TODO or IN-PROGRESS**
3. **If not appropriate, investigate and resolve**
4. **Update to IN-PROGRESS when beginning**: ${helpers.command("tasks.status.set")}

### During Implementation

1. **Monitor status regularly**: ${helpers.command("tasks.status.get")}
2. **Keep status aligned with actual progress**
3. **Update to BLOCKED if issues arise**: ${helpers.command("tasks.status.set")}
4. **Document any status changes and reasons**

### Before PR Creation

1. **Verify implementation is complete**
2. **Update to IN-REVIEW**: ${helpers.command("tasks.status.set")} 
3. **Ensure status change is successful**
4. **Proceed with PR creation only after status update**

### After PR Merge

1. **Verify status shows DONE**: ${helpers.command("tasks.status.get")}
2. **If not automatic, manually update**: ${helpers.command("tasks.status.set")}
3. **Confirm task is properly completed**

## Status Query Patterns

### Check Single Task
\`\`\`bash
${helpers.command("tasks.status.get")}
\`\`\`

### List Tasks by Status
\`\`\`bash
# Find tasks ready to work on
${helpers.command("tasks.list")}

# Find tasks in progress
${helpers.command("tasks.list")}

# Find blocked tasks
${helpers.command("tasks.list")}
\`\`\`

### Update Task Status
\`\`\`bash
# Start implementation
${helpers.command("tasks.status.set")}

# Mark for review
${helpers.command("tasks.status.set")}

# Mark as blocked with reason
${helpers.command("tasks.status.set")}
\`\`\`

## Status Automation

Some status transitions can be automated:

- **Session creation** can auto-update TO IN-PROGRESS
- **PR creation** can auto-update to IN-REVIEW  
- **PR merge** can auto-update to DONE

Always verify automated updates occurred correctly.

## Common Status Issues

### Issue: Status stuck in wrong state
**Solution**: Use ${helpers.command("tasks.status.set")} to correct it, then investigate why it got wrong

### Issue: Status not updating after PR merge
**Solution**: Manually update with ${helpers.command("tasks.status.set")}, check automation settings

### Issue: Multiple people working on same task
**Solution**: Check status before starting work, coordinate with team on assignment

### Issue: Unclear when to update status
**Solution**: Follow the transition rules above, when in doubt check current status and update accordingly

## Integration with Workflow

Status management integrates with:

- **task-implementation-workflow**: Status updates at each phase
- **minsky-session-management**: Status changes during session operations
- **pr-preparation-workflow**: Status transition during PR creation
- **minsky-workflow-orchestrator**: Overall workflow context

## Verification Checklist

Before considering status management complete:

- [ ] Current status checked and verified
- [ ] Status appropriate for planned action
- [ ] Status updated when starting new phase
- [ ] Status changes documented with reasons
- [ ] Status transitions follow defined rules
- [ ] Final status reflects actual completion state`;
  },
  generateMeta: (context) => ({
    name: "Task Status Protocol",
    description:
      "Procedures for checking and updating task status throughout the implementation lifecycle",
    tags: ["task", "status", "protocol", "workflow"],
  }),
};

/**
 * Template for PR Preparation Workflow
 */
const PR_PREPARATION_WORKFLOW_TEMPLATE: RuleTemplate = {
  id: "pr-preparation-workflow",
  name: "PR Preparation Workflow",
  description: "Complete workflow for preparing, creating, and managing pull requests",
  tags: ["pr", "pullrequest", "workflow"],
  generateContent: (context) => {
    const { helpers } = context;

    return `# PR Preparation Workflow

This rule provides a complete workflow for preparing, creating, and managing pull requests in the Minsky system.

## Overview

Pull requests are the mechanism for integrating completed work from sessions back into the main codebase. The PR workflow ensures:

- Proper review of all changes
- Integration with task management
- Quality assurance before merge
- Documentation of changes

## Prerequisites

Before creating a PR, ensure:

1. **Implementation is complete** - All task requirements met
2. **Tests are passing** - Full test suite runs successfully
3. **Task status is correct** - Should be IN-REVIEW before PR creation
4. **Session is current** - Session updated with latest changes

## PR Creation Process

### Step 1: Pre-PR Verification

**Check task status**: ${helpers.command("tasks.status.get")}
- Verify task is in appropriate state for PR creation
- Update to IN-REVIEW if not already: ${helpers.command("tasks.status.set")}

**Verify session state**: ${helpers.command("session.get")}
- Confirm session is properly configured
- Check that all changes are committed
- Ensure session is up to date

### Step 2: Create Pull Request

**Generate PR from session**: ${helpers.command("session.pr.create")}
- Creates PR from session branch to main branch
- Automatically links PR to associated task
- May update task status to IN-REVIEW

**Provide PR details**:
- Use descriptive title including task ID
- Write comprehensive description of changes
- Include testing information
- Reference any relevant issues or dependencies

### Step 3: PR Content Verification

After PR creation:

1. **Review PR description** - Ensure it follows guidelines
2. **Check file changes** - Verify all intended changes included
3. **Confirm task linkage** - PR should reference task ID
4. **Validate build status** - Ensure CI/CD passes

## PR Description Format

Follow this structure for PR descriptions:

\`\`\`markdown
# <type>(#<task-id>): <Short description>

## Summary
Brief description of what was changed and why.

## Changes
### Added
- List new features or functionality

### Changed  
- List modifications to existing functionality

### Fixed
- List bugs or issues resolved

## Testing
Description of testing performed.

## Checklist
- [x] All requirements implemented
- [x] Tests written and passing
- [x] Documentation updated
\`\`\`

## PR Types

Use these prefixes for PR titles:

- **feat**: New feature
- **fix**: Bug fix  
- **docs**: Documentation changes
- **style**: Code style changes
- **refactor**: Code refactoring
- **perf**: Performance improvements
- **test**: Test additions or modifications
- **chore**: Build process or tool changes

## PR Management Commands

### PR Creation
**Create PR from session**: ${helpers.command("session.pr.create")}
- Primary method for creating PRs
- Handles task integration automatically
- Manages branch and status updates

### PR Information
**Get session PR info**: ${helpers.command("session.get")}
- Shows PR status for session
- Displays PR URL and details
- Indicates merge status

## PR Review Process

### For PR Authors

1. **Respond to feedback promptly**
2. **Make requested changes in session workspace**
3. **Push updates to session branch**
4. **Re-request review after changes**

### For PR Reviewers

1. **Review code changes thoroughly**
2. **Verify requirements are met**
3. **Check test coverage and quality**
4. **Provide constructive feedback**
5. **Approve when satisfied with changes**

## PR Merge Process

### Automated Merge
When using Minsky's integrated workflow:
- PR merge can trigger automatic task status update to DONE
- Session cleanup may be automated
- Branch deletion handled automatically

### Manual Verification
After PR merge:

1. **Verify task status**: ${helpers.command("tasks.status.get")}
2. **Confirm changes in main branch**
3. **Update task status if needed**: ${helpers.command("tasks.status.set")}

## Common PR Scenarios

### Scenario 1: Standard Feature PR

\`\`\`bash
# 1. Verify implementation complete and tests passing
cd \$(${helpers.command("session.dir")})

# 2. Update task status to IN-REVIEW
${helpers.command("tasks.status.set")}

# 3. Create PR from session
${helpers.command("session.pr.create")}
\`\`\`

### Scenario 2: Bug Fix PR

\`\`\`bash
# 1. Ensure fix is complete and tested
cd \$(${helpers.command("session.dir")})

# 2. Update task status
${helpers.command("tasks.status.set")}

# 3. Create PR with fix prefix
${helpers.command("session.pr.create")}
\`\`\`

### Scenario 3: Documentation PR

\`\`\`bash
# 1. Verify documentation changes
cd \$(${helpers.command("session.dir")})

# 2. Set appropriate status
${helpers.command("tasks.status.set")}

# 3. Create docs PR
${helpers.command("session.pr.create")}
\`\`\`

## PR Best Practices

### Content Guidelines
- **Keep PRs focused** - One task per PR
- **Write clear descriptions** - Explain what and why
- **Include testing info** - How changes were verified
- **Reference task ID** - Link to original requirement

### Technical Guidelines
- **Ensure tests pass** - All CI/CD checks green
- **Keep changes minimal** - Only what's needed for task
- **Handle conflicts promptly** - Resolve merge conflicts quickly
- **Update documentation** - Keep docs current with changes

### Process Guidelines
- **Create PR when ready** - Don't create draft PRs prematurely
- **Respond to reviews quickly** - Keep momentum going
- **Test final version** - Verify changes after addressing feedback
- **Clean up after merge** - Close related issues, update status

## Troubleshooting

### Problem: PR creation fails
**Solution**: Check session status with ${helpers.command("session.get")}, ensure all changes committed

### Problem: PR not linked to task
**Solution**: Verify task ID in PR title and description, update if needed

### Problem: Tests failing in PR
**Solution**: Run tests in session workspace, fix failures before requesting review

### Problem: Merge conflicts
**Solution**: Update session with ${helpers.command("session.update")}, resolve conflicts, push updates

## Integration Points

This workflow integrates with:

- **task-implementation-workflow**: PR creation is final phase of implementation
- **task-status-protocol**: Status updates during PR lifecycle
- **minsky-session-management**: PRs created from sessions
- **pr-description-guidelines**: Detailed formatting requirements

## Verification Checklist

Before creating PR:

- [ ] All requirements implemented
- [ ] Tests written and passing  
- [ ] Task status is IN-REVIEW
- [ ] Session is up to date
- [ ] Changes are committed and pushed
- [ ] PR title includes task ID
- [ ] PR description is complete and follows format`;
  },
  generateMeta: (context) => ({
    name: "PR Preparation Workflow",
    description: "Complete workflow for preparing, creating, and managing pull requests",
    tags: ["pr", "pullrequest", "git", "workflow"],
  }),
};

/**
 * All default templates available in the system
 */
export const DEFAULT_TEMPLATES: RuleTemplate[] = [
  MINSKY_WORKFLOW_TEMPLATE,
  INDEX_TEMPLATE,
  MCP_USAGE_TEMPLATE,
  MINSKY_WORKFLOW_ORCHESTRATOR_TEMPLATE,
  TASK_IMPLEMENTATION_WORKFLOW_TEMPLATE,
  MINSKY_SESSION_MANAGEMENT_TEMPLATE,
  TASK_STATUS_PROTOCOL_TEMPLATE,
  PR_PREPARATION_WORKFLOW_TEMPLATE,
];

/**
 * Template for the main Minsky workflow orchestrator rule
 * Converts hardcoded CLI commands to conditional CLI/MCP syntax based on interface preference
 */
