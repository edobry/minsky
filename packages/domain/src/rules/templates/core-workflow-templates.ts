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

This document describes the rules installed in this project and identifies which apply in different usage scenarios.

## Core Workflow Rules

These rules define the fundamental workflow and processes for using Minsky:

| Rule | Description | When to Apply |
|------|-------------|--------------|
| **minsky-workflow** | Defines the complete workflow for working with tasks and sessions. Includes task selection, status management, implementation process, and PR preparation | **Always required**. Applies to any interaction with tasks or sessions |
| **minsky-workflow-orchestrator** | Entry point for the Minsky workflow system — links to the focused workflow rules | Start here to understand the overall workflow |
| **task-implementation-workflow** | Step-by-step process for implementing tasks in a session workspace | When starting or continuing implementation work |
| **task-status-protocol** | Procedures for checking and updating task status correctly | When transitioning task state or checking current status |
| **pr-preparation-workflow** | Guidelines for preparing and submitting pull requests | When creating or updating a PR |
| **minsky-session-management** | Session lifecycle management — creation, navigation, cleanup | When working with sessions |

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

## Usage Scenarios & Applicable Rules

### For New Contributors

When a developer first joins the project, they should focus on:

1. **minsky-workflow** - Understand the overall process
2. **task-implementation-workflow** - Learn the implementation workflow

### When Implementing Features

During feature implementation, the most relevant rules are:

1. **minsky-workflow** - Follow the proper process
2. **task-implementation-workflow** - Step-by-step implementation guidance
3. **task-status-protocol** - Keep task status accurate

### When Fixing Bugs

For bug fixes, prioritize:

1. **minsky-workflow** - Follow the correct task/session workflow
2. **task-implementation-workflow** - Apply structured implementation process
3. **pr-preparation-workflow** - Document the fix in the PR

### When Reviewing Code

Code reviewers should focus on:

1. **pr-preparation-workflow** - Ensure proper PR documentation

### When Setting Up New Projects

For initializing new projects with Minsky:

1. **minsky-workflow** - Establish the core workflow
2. **minsky-session-management** - Understand session creation

## Rule Relationships

Some rules are closely related and often used together:

- **minsky-workflow** and **minsky-workflow-orchestrator** provide the top-level orientation; the other rules drill into specific sub-workflows
- **task-implementation-workflow**, **task-status-protocol**, and **pr-preparation-workflow** form the complete implementation lifecycle
- **minsky-session-management** supports all rules that involve session workspaces

This index describes the rules installed in this project. Additional rules can be added via \`minsky rules create\`.`;
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

    const isCursorFormat = context.config.ruleFormat === "cursor";
    const ruleLink = (name: string, description: string): string => {
      if (isCursorFormat) {
        return `[**${name}**](mdc:.cursor/rules/${name}.mdc) - ${description}`;
      }
      // Generic rule format — plain text reference works under any agent/IDE
      return `**${name}** — ${description}`;
    };

    return `# Minsky Workflow System

This rule provides an overview of the Minsky workflow system and serves as an entry point to the more detailed workflow rules. The Minsky workflow has been divided into focused rules to make it easier to understand and follow.

## Core Workflow Rules

The following rules form the complete Minsky workflow system:

2. ${ruleLink("task-implementation-workflow", "Step-by-step process for implementing tasks")}
3. ${ruleLink("task-status-protocol", "Procedures for checking and updating task status")}
4. ${ruleLink("pr-preparation-workflow", "Guidelines for preparing and submitting PRs")}

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
   - Apply: task-status-protocol

2. **Session Creation and Navigation**
   - First: Create or re-enter a session for the task
   - Then: Navigate to the session directory
   - Apply: session-first-workflow

3. **Task Implementation**
   - First: Understand task requirements
   - Then: Implement the solution in the session workspace
   - Apply: task-implementation-workflow

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
   - Apply: task-status-protocol

## Common Workflow Questions

### Task-Related Questions

- **"What tasks are available?"**
  → Use ${helpers.command("tasks.list")}

- **"How do I start working on a task?"**
  → Apply session-first-workflow to create a session

- **"How do I check task status?"**
  → Apply task-status-protocol and use ${helpers.command("tasks.status.get")}

### Session-Related Questions

- **"How do I create a session?"**
  → Apply session-first-workflow and use ${helpers.command("session.start")}

- **"How do I get back to my session?"**
  → Apply session-first-workflow and use ${helpers.command("session.dir")}

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
|----------------|---------------|--------------------|
| **Status Tracking Issue** | task-status-protocol | Verify implementation state vs. tracked status |
| **PR Creation Problem** | pr-preparation-workflow | Check prerequisites and retry |
| **PR Approval Failure** | pr-preparation-workflow | Address merge conflicts or PR issues before retry |

## Rule Integration Table

| Rule | Primary Purpose | Integrates With |
|------|-----------------|----------------|
| task-implementation-workflow | Task implementation | task-status-protocol, pr-preparation-workflow |
| task-status-protocol | Status management | task-status-workflow-protocol, task-implementation-workflow |
| pr-preparation-workflow | PR preparation | task-implementation-workflow, pr-description-guidelines |

## Supporting Rules

The Minsky workflow is supported by these additional rules:

- ${ruleLink("minsky-session-management", "Session lifecycle management — creation, navigation, cleanup")}
- ${ruleLink("task-status-protocol", "Procedures for checking and updating task status")}`;
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
