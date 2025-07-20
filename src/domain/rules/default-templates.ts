/**
 * Default Rule Templates
 * 
 * This module contains template definitions for the default rules that were
 * previously generated statically in init.ts. These templates can now generate
 * CLI, MCP, or hybrid versions based on configuration.
 */

import type { TemplateContext } from "./template-system";
import type { RuleTemplate } from "./rule-template-service";

// ============================================================================
// Minsky Workflow Template
// ============================================================================

export const minskyWorkflowTemplate: RuleTemplate = {
  id: "minsky-workflow",
  name: "Minsky Workflow",
  description: "Defines the complete workflow for working with tasks and sessions",
  alwaysApply: true,
  tags: ["workflow", "core"],
  generateContent: (context: TemplateContext): string => {
    const { helpers } = context;
    
    return `# Minsky Workflow

⛔️ **STOP - READ THIS FIRST**

## Mandatory Session Creation

**NO IMPLEMENTATION WORK CAN BEGIN WITHOUT AN ACTIVE SESSION**

Before implementing ANY task or making ANY code changes, you MUST:

\`\`\`bash
# 1. Check task status
${helpers.codeBlock("tasks.status.get", "'#XXX'")}

# 2. Create or verify session exists
${helpers.codeBlock("session.start", "--task XXX")}

# 3. Enter session directory
cd $(${helpers.codeBlock("session.dir", "task#XXX")})
\`\`\`

❌ If these steps are not completed:
- DO NOT make any code changes
- DO NOT commit any files
- DO NOT proceed with implementation

✅ These activities are allowed without a session:
- Reading code
- Searching the codebase
- Investigating issues
- Planning implementation
- Creating new task specifications

This is a HARD REQUIREMENT for all implementation work. There are NO EXCEPTIONS.

⚠️ **CRITICAL: ALL TASK AND SESSION QUERIES MUST USE THE MINSKY CLI**
⚠️ **CRITICAL: ALL COMMITS MUST BE PUSHED IMMEDIATELY**

## Core Principles

1. **Always Use Minsky CLI for Task/Session Data**
   - NEVER use file listings or static documentation
   - NEVER directly manipulate Minsky's state files or databases
   - ALWAYS use appropriate commands:
     \`\`\`bash
     # For task queries
     ${helpers.codeBlock("tasks.list")}          # List all tasks
     ${helpers.codeBlock("tasks.get", "'#XXX' --json")}    # Get specific task details
     ${helpers.codeBlock("tasks.status.get", "'#XXX'")}    # Get task status

     # For session queries
     ${helpers.codeBlock("session.list", "--json")}        # List all sessions
     ${helpers.codeBlock("session.get", "<n>")}            # Get session details by name
     ${helpers.codeBlock("session.get", "--task XXX")}     # Get session details by task ID
     \`\`\`

2. **Real-Time Data Over Static Files**
   - Task information comes from the live system, not files
   - Session state must be queried through CLI, not assumed
   - File system should never be used as a primary data source

## CRITICAL REQUIREMENT: SESSION-FIRST IMPLEMENTATION

A session MUST be created and active before any code changes. Before examining or modifying any code, you MUST:
1. ${helpers.workflowStep("Verify task status", "tasks.status.get", "check '#id'")}
2. ${helpers.workflowStep("Create or identify an existing session", "session.start", "with --task id")}
3. ${helpers.workflowStep("Enter the session directory", "session.dir", "for session-name")}

## Repository Isolation Warning

**The session directory contains a COMPLETELY SEPARATE CLONE of the repository.**

- Changes made to files in the main workspace WILL NOT appear in the session branch
- Changes made to files in the session directory DO NOT affect the main workspace
- Always confirm your current working directory with \`pwd\` before making any changes

${helpers.conditionalSection(`
## MCP Interface Notes

When using MCP tools instead of CLI commands:
- ${helpers.command("tasks.list", "query available tasks")}
- ${helpers.command("tasks.status.get", "check task status")}
- ${helpers.command("session.start", "create new sessions")}
- ${helpers.command("session.dir", "get session directory path")}
`, ["mcp", "hybrid"])}

${helpers.conditionalSection(`
## CLI Interface Notes

Use the globally installed \`minsky\` CLI for all operations:
- ${helpers.command("tasks.list", "query available tasks")}
- ${helpers.command("tasks.status.get", "check task status")}
- ${helpers.command("session.start", "create new sessions")}
- ${helpers.command("session.dir", "get session directory path")}
`, ["cli", "hybrid"])}`;
  }
};

// ============================================================================
// Rules Index Template
// ============================================================================

export const rulesIndexTemplate: RuleTemplate = {
  id: "index", 
  name: "Minsky Rules Index",
  description: "Categorizes all available rules in the Minsky ecosystem",
  tags: ["documentation", "index"],
  generateContent: (context: TemplateContext): string => {
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
- **List tasks**: ${helpers.command("tasks.list", "query available tasks")}
- **Get task details**: ${helpers.command("tasks.get", "retrieve task information")}
- **Check status**: ${helpers.command("tasks.status.get", "check task status")}
- **Update status**: ${helpers.command("tasks.status.set", "update task status")}

### Session Management Commands  
- **List sessions**: ${helpers.command("session.list", "view all sessions")}
- **Start session**: ${helpers.command("session.start", "create new session")}
- **Get session info**: ${helpers.command("session.get", "retrieve session details")}
- **Get session directory**: ${helpers.command("session.dir", "get session path")}

${helpers.conditionalSection(`
### MCP Tools Reference
- Use MCP tools for programmatic access to Minsky functionality
- All commands available through structured tool calls
- Parameters passed as objects rather than CLI flags
`, ["mcp", "hybrid"])}

${helpers.conditionalSection(`
### CLI Commands Reference
- Use globally installed \`minsky\` CLI for all operations
- Commands support \`--help\` for detailed usage information
- JSON output available with \`--json\` flag for most commands
`, ["cli", "hybrid"])}

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
  }
};

// ============================================================================
// MCP Usage Template
// ============================================================================

export const mcpUsageTemplate: RuleTemplate = {
  id: "mcp-usage",
  name: "MCP Usage",
  description: "Guidelines for using the Minsky Control Protocol (MCP) for AI agent interaction",
  tags: ["mcp", "integration"],
  generateContent: (context: TemplateContext): string => {
    const { config, helpers } = context;
    
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
- ${helpers.command("tasks.list", "list all tasks")}
- ${helpers.command("tasks.get", "get task by ID")}
- ${helpers.command("tasks.status.get", "check task status")}
- ${helpers.command("tasks.status.set", "update task status")}
- ${helpers.command("tasks.create", "create new task")}

### Session Management
- ${helpers.command("session.list", "list all sessions")}
- ${helpers.command("session.get", "get session details")}
- ${helpers.command("session.start", "create new session")}
- ${helpers.command("session.dir", "get session directory")}
- ${helpers.command("session.pr", "create pull request")}

### Rules Management
- ${helpers.command("rules.list", "list all rules")}
- ${helpers.command("rules.get", "get rule by ID")}
- ${helpers.command("rules.create", "create new rule")}
- ${helpers.command("rules.update", "update existing rule")}

## Usage Examples

### Task Management Example
\`\`\`
${helpers.codeBlock("tasks.list")}
${helpers.codeBlock("tasks.get", "taskId: \"#123\"")}
\`\`\`

### Session Management Example  
\`\`\`
${helpers.codeBlock("session.start", "task: \"#123\"")}
${helpers.codeBlock("session.dir", "name: \"task#123\"")}
\`\`\`

## Parameter Documentation

${helpers.parameterDoc("tasks.list")}

${helpers.parameterDoc("session.start")}

${helpers.conditionalSection(`
## CLI Alternative

When MCP is not available, use the CLI commands:
- \`minsky tasks list --json\`
- \`minsky session start --task 123\`
- \`minsky session dir task#123\`
`, ["hybrid"])}

See README-MCP.md for detailed protocol specifications.`;
  }
};

// ============================================================================
// Template Registry
// ============================================================================

/**
 * All default templates that replace the static content from init.ts
 */
export const DEFAULT_TEMPLATES: RuleTemplate[] = [
  minskyWorkflowTemplate,
  rulesIndexTemplate,
  mcpUsageTemplate
];

/**
 * Register all default templates with a RuleTemplateService
 */
export function registerDefaultTemplates(service: { registerTemplate: (template: RuleTemplate) => void }): void {
  DEFAULT_TEMPLATES.forEach(template => {
    service.registerTemplate(template);
  });
} 
