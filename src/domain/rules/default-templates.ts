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
${helpers.conditionalSection(isCliMode || isHybridMode, `
**List Available Tasks**
\`\`\`bash
${helpers.command("tasks.list")}
\`\`\`
`, "")}
${helpers.conditionalSection(isMcpMode || isHybridMode, `
**List Available Tasks (MCP)**
\`\`\`
${helpers.command("tasks.list")}
\`\`\`
`, "")}

**Get Task Details**
${helpers.conditionalSection(isCliMode || isHybridMode, `
\`\`\`bash
${helpers.command("tasks.get")}
\`\`\`
`, "")}
${helpers.conditionalSection(isMcpMode || isHybridMode, `
\`\`\`
${helpers.command("tasks.get")}
\`\`\`
`, "")}

**Check Task Status**
${helpers.conditionalSection(isCliMode || isHybridMode, `
\`\`\`bash
${helpers.command("tasks.status.get")}
\`\`\`
`, "")}
${helpers.conditionalSection(isMcpMode || isHybridMode, `
\`\`\`
${helpers.command("tasks.status.get")}
\`\`\`
`, "")}

### 2. Session Management

**Start New Session**
${helpers.conditionalSection(isCliMode || isHybridMode, `
\`\`\`bash
${helpers.command("session.start")}
\`\`\`
`, "")}
${helpers.conditionalSection(isMcpMode || isHybridMode, `
\`\`\`
${helpers.command("session.start")}
\`\`\`
`, "")}

**Get Session Directory**
${helpers.conditionalSection(isCliMode || isHybridMode, `
\`\`\`bash
${helpers.command("session.dir")}
\`\`\`
`, "")}
${helpers.conditionalSection(isMcpMode || isHybridMode, `
\`\`\`
${helpers.command("session.dir")}
\`\`\`
`, "")}

### 3. Implementation Process

1. **Create Session**: Use session.start with task ID
2. **Work in Session**: All code changes happen in the session directory
3. **Regular Commits**: Commit changes frequently
4. **Create PR**: Use session.pr when ready for review
5. **Update Status**: Set task status to IN-REVIEW

### 4. Review & Completion

**Create Pull Request**
${helpers.conditionalSection(isCliMode || isHybridMode, `
\`\`\`bash
${helpers.command("session.pr")}
\`\`\`
`, "")}
${helpers.conditionalSection(isMcpMode || isHybridMode, `
\`\`\`
${helpers.command("session.pr")}
\`\`\`
`, "")}

**Update Task Status**
${helpers.conditionalSection(isCliMode || isHybridMode, `
\`\`\`bash
${helpers.command("tasks.status.set")}
\`\`\`
`, "")}
${helpers.conditionalSection(isMcpMode || isHybridMode, `
\`\`\`
${helpers.command("tasks.status.set")}
\`\`\`
`, "")}

## Best Practices

- Always work in sessions for code isolation
- Use descriptive commit messages
- Update task status at key milestones
- Document any architectural decisions
- Test changes before creating PRs

## Command Parameters

${helpers.parameterDoc("tasks.list")}

${helpers.parameterDoc("session.start")}

${helpers.parameterDoc("session.pr")}
`;
  },
  generateMeta: (context) => ({
    name: "Minsky Workflow",
    description: "Core workflow orchestration guide for Minsky",
    tags: ["workflow", "core", "required"]
  })
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
    tags: ["index", "navigation", "overview"]
  })
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
- ${helpers.command("session.pr")} - create pull request

### Rules Management
- ${helpers.command("rules.list")} - list all rules
- ${helpers.command("rules.get")} - get rule by ID
- ${helpers.command("rules.create")} - create new rule
- ${helpers.command("rules.update")} - update existing rule

## Usage Examples

### Task Management Example
\`\`\`
${helpers.codeBlock(helpers.command("tasks.list"), "bash")}
${helpers.codeBlock(`taskId: "#123"\\n${  helpers.command("tasks.get")}`, "bash")}
\`\`\`

### Session Management Example  
\`\`\`
${helpers.codeBlock(`task: "#123"\\n${  helpers.command("session.start")}`, "bash")}
${helpers.codeBlock(`name: "task#123"\\n${  helpers.command("session.dir")}`, "bash")}
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
    tags: ["mcp", "protocol", "ai"]
  })
};

/**
 * All default templates available in the system
 */
export const DEFAULT_TEMPLATES: RuleTemplate[] = [
  MINSKY_WORKFLOW_TEMPLATE,
  INDEX_TEMPLATE,
  MCP_USAGE_TEMPLATE
]; 
