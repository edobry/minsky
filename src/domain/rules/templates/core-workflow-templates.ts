/**
 * Core Workflow Rule Templates
 *
 * Contains MINSKY_WORKFLOW_TEMPLATE, INDEX_TEMPLATE, and MINSKY_WORKFLOW_ORCHESTRATOR_TEMPLATE.
 */

import { type RuleTemplate } from "../rule-template-service";

/**
 * Template for the main Minsky workflow rule
 */
export const MINSKY_WORKFLOW_TEMPLATE: RuleTemplate = {
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
export const INDEX_TEMPLATE: RuleTemplate = {
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

#### List Tasks
${helpers.readableCommand("tasks.list", "Query available tasks")}

#### Get Task Details
${helpers.readableCommand("tasks.get", "Retrieve task information")}

#### Check Task Status
${helpers.readableCommand("tasks.status.get", "Check task status")}

#### Update Task Status
${helpers.readableCommand("tasks.status.set", "Update task status")}

### Session Management Commands

#### List Sessions
${helpers.readableCommand("session.list", "View all sessions")}

#### Start Session
${helpers.readableCommand("session.start", "Create new session")}

#### Get Session Info
${helpers.readableCommand("session.get", "Retrieve session details")}

#### Get Session Directory
${helpers.readableCommand("session.dir", "Get session path")}

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
 * Template for Minsky Workflow Orchestrator
 */
export const MINSKY_WORKFLOW_ORCHESTRATOR_TEMPLATE: RuleTemplate = {
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
| task-status-protocol | Status management | task-status-workflow-protocol, task-implementation-workflow |
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

export const CORE_WORKFLOW_TEMPLATES: RuleTemplate[] = [
  MINSKY_WORKFLOW_TEMPLATE,
  INDEX_TEMPLATE,
  MINSKY_WORKFLOW_ORCHESTRATOR_TEMPLATE,
];
