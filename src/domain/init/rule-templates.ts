import * as path from "path";
import { createRuleTemplateService } from "../rules/rule-template-service";
import type { RuleFormat } from "../rules";
import type { McpOptions } from "./config-content";

/**
 * Generate rules using the template system
 */
export async function generateRulesWithTemplateSystem(
  rulesDirPath: string,
  ruleFormat: RuleFormat,
  overwrite: boolean,
  mcpEnabled: boolean
): Promise<void> {
  const workspacePath = path.dirname(path.dirname(rulesDirPath)); // Get workspace path from rules dir
  const service = createRuleTemplateService(workspacePath);

  // Register the init templates
  service.registerInitTemplates();

  // Configure rule generation based on init parameters
  const config = {
    interface: mcpEnabled ? ("hybrid" as const) : ("cli" as const),
    mcpEnabled,
    mcpTransport: "stdio" as const,
    preferMcp: false, // Default to CLI for familiarity
    ruleFormat,
    outputDir: rulesDirPath,
  };

  // Generate the comprehensive core workflow rules
  const selectedRules = [
    "minsky-workflow",
    "index",
    "minsky-workflow-orchestrator",
    "task-implementation-workflow",
    "minsky-session-management",
    "task-status-protocol",
    "pr-preparation-workflow",
  ];
  if (mcpEnabled) {
    selectedRules.push("mcp-usage");
  }

  const result = await service.generateRules({
    config,
    selectedRules,
    overwrite,
    dryRun: false,
  });

  if (!result.success) {
    throw new Error(`Failed to generate rules: ${result.errors.join(", ")}`);
  }
}

/**
 * Generate MCP rule using the template system
 */
export async function generateMcpRuleWithTemplateSystem(
  rulesDirPath: string,
  ruleFormat: RuleFormat,
  overwrite: boolean,
  mcpOptions?: McpOptions
): Promise<void> {
  const workspacePath = path.dirname(path.dirname(rulesDirPath)); // Get workspace path from rules dir
  const service = createRuleTemplateService(workspacePath);

  // Register the init templates
  service.registerInitTemplates();

  // Configure rule generation for MCP
  const config = {
    interface: "mcp" as const,
    mcpEnabled: true,
    mcpTransport: (mcpOptions?.transport || "stdio") as "stdio" | "http",
    preferMcp: true, // For MCP-specific rule
    ruleFormat,
    outputDir: rulesDirPath,
  };

  const result = await service.generateRules({
    config,
    selectedRules: ["mcp-usage"],
    overwrite,
    dryRun: false,
  });

  if (!result.success) {
    throw new Error(`Failed to generate MCP rule: ${result.errors.join(", ")}`);
  }
}

/**
 * Returns the content for the minsky.mdc rule file
 * @deprecated Use generateRulesWithTemplateSystem instead
 */
export function getMinskyRuleContent(): string {
  return `# Minsky Workflow

⛔️ **STOP - READ THIS FIRST**

## Mandatory Session Creation

**NO IMPLEMENTATION WORK CAN BEGIN WITHOUT AN ACTIVE SESSION**

Before implementing ANY task or making ANY code changes, you MUST:

\`\`\`bash
# 1. Check task status
minsky tasks status get '#XXX'

# 2. Create or verify session exists
minsky session start --task XXX

# 3. Enter session directory
cd $(minsky session dir task#XXX)
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
   - ALWAYS use appropriate minsky commands:
     \`\`\`bash
     # For task queries
     minsky tasks list --json          # List all tasks
     minsky tasks get '#XXX' --json    # Get specific task details
     minsky tasks status get '#XXX'    # Get task status

     # For session queries
     minsky session list --json        # List all sessions
     minsky session get <n>            # Get session details by name
     minsky session get --task XXX     # Get session details by task ID
     \`\`\`

2. **Real-Time Data Over Static Files**
   - Task information comes from the live system, not files
   - Session state must be queried through CLI, not assumed
   - File system should never be used as a primary data source

## CRITICAL REQUIREMENT: SESSION-FIRST IMPLEMENTATION

A session MUST be created and active before any code changes. Before examining or modifying any code, you MUST:
1. Verify task status (\`minsky tasks status get '#id'\`)
2. Create or identify an existing session (\`minsky session start --task id\`)
3. Enter the session directory (\`cd $(minsky session dir session-id)\`)

## Repository Isolation Warning

**The session directory contains a COMPLETELY SEPARATE CLONE of the repository.**

- Changes made to files in the main workspace WILL NOT appear in the session branch
- Changes made to files in the session directory DO NOT affect the main workspace
- Always confirm your current working directory with \`pwd\` before making any changes
`;
}

/**
 * Returns the content for the index.mdc rule file
 */
export function getRulesIndexContent(): string {
  return `# Minsky Rules Index

This document categorizes all available rules in the Minsky ecosystem, describes their purpose, and identifies which rules apply in different usage scenarios.

## Core Workflow Rules

These rules define the fundamental workflow and processes for using Minsky:

| Rule | Description | When to Apply |
|------|-------------|--------------|
| **minsky-workflow** | Defines the complete workflow for working with tasks and sessions. Includes task selection, status management, implementation process, and PR preparation | **Always required**. Applies to any interaction with tasks or sessions |
| **session-first-workflow** | Enforces that all implementation work happens in dedicated sessions | During all implementation _tasks, ensuring code isolation |
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
| **error-handling** (skill) | Standards for comprehensive error handling | When working with operations that might fail |
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
3. **error-handling** (skill) & **dont-ignore-errors** - Ensure resilient code
4. **testable-design** & **tests** - Create properly tested features
DEFAULT_RETRY_COUNT. **changelog** - Document the changes

### When Fixing Bugs

For bug fixes, prioritize:

1. **test-driven-bugfix** - Use proper bug-fixing methodology
2. **dont-ignore-errors** - Ensure all errors are handled
3. **test-expectations** - Update tests appropriately
4. **changelog** - Document the fix

### When Reviewing Code

Code reviewers should focus on:

1. **pr-description-guidelines** - Ensure proper documentation
2. **error-handling** (skill) & **dont-ignore-errors** - Verify error handling
3. **domain-oriented-modules** & **module-organization** - Check structural alignment
4. **testable-design** & **tests** - Validate test coverage
DEFAULT_RETRY_COUNT. **changelog** - Confirm changes are documented

### When Creating New Rules

When developing new Minsky rules:

1. **rule-creation-guidelines** - Follow the standards for rule creation

### When Setting Up New Projects

For initializing new projects with Minsky:

1. **minsky-workflow** - Establish the core workflow
2. **session-first-workflow** - Enforce proper session usage
3. **creating-tasks** - Enable structured task creation
4. **changelog** - Set up change tracking
DEFAULT_RETRY_COUNT. **module-organization** & **command-organization** - If developing with the same architecture

## Rule Relationships

Some rules are closely related and often used together:

- **module-organization** and **domain-oriented-modules** complement each other for code structuring
- **testable-design**, **designing-tests**, and **tests** form a comprehensive testing approach
- **minsky-workflow** and **session-first-workflow** together define the complete development process
- **error-handling** (skill) and **dont-ignore-errors** ensure comprehensive error management
- **pr-description-guidelines** and **changelog** both contribute to documentation of changes

This index serves as a guide to help you understand which rules are relevant to different aspects of working with Minsky and how they interact with each other.`;
}
