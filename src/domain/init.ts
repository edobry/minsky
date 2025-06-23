import * as fs from "fs";
import { DEFAULT_DEV_PORT} from "../utils/constants";
import * as path from "path";
import { z } from "zod";
export const initializeProjectParamsSchema = z.object({
  _repoPath: z.string(),
  backend: z.enum(["tasks.md", "tasks.csv"]),
  ruleFormat: z.enum(["cursor", "generic"]),
  mcp: z
    .object({
      enabled: z.boolean().optional().default(true),
      transport: z.enum(["stdio", "sse", "httpStream"]).optional().default("stdio"),
      port: z.number().optional(),
      host: z.string().optional(),
    })
    .optional(),
  mcpOnly: z.boolean().optional().default(false),
  overwrite: z.boolean().optional().default(false),
});

export type InitializeProjectParams = z.infer<typeof initializeProjectParamsSchema>;

/**
 * The interface-agnostic function for initializing a project with Minsky configuration
 * This function acts as the primary domain function for the init command
 */
export async function initializeProjectFromParams(_params: InitializeProjectParams): Promise<void> {
  // Validate the parameters
  const validatedParams = initializeProjectParamsSchema.parse(params);

  // Call the original initialization function
  return initializeProject(validatedParams);
}

export interface InitializeProjectOptions {
  repoPath: string;
  backend: "tasks.md" | "tasks.csv";
  ruleFormat: "cursor" | "generic";
  mcp?: {
    enabled: boolean;
    transport: "stdio" | "sse" | "httpStream";
    port?: number;
    host?: string;
  };
  mcpOnly?: boolean;
  overwrite?: boolean;
}

/**
 * Creates directories if they don't exist, and errors if files already exist
 */
export async function initializeProject(
  {
    repoPath,
    backend,
    ruleFormat,
    mcp,
    mcpOnly = false,
    overwrite = false,
  }: InitializeProjectOptions,
  fileSystem: FileSystem = fs
): Promise<void> {
  // When mcpOnly is true, we only set up MCP configuration and skip other setup
  if (!mcpOnly) {
    // Check if backend is implemented
    if (backend === "tasks.csv") {
      throw new Error("The tasks.csv backend is not implemented yet.");
    }

    // Create process/tasks directory structure
    const tasksDir = path.join(repoPath, "process", "tasks");
    await createDirectoryIfNotExists(tasksDir, fileSystem);

    // Initialize the tasks backend
    if (backend === "tasks.md") {
      const tasksFilePath = path.join(repoPath, "process", "tasks.md");
      await createFileIfNotExists(
        tasksFilePath,
        `# Minsky Tasks

## Task List

| ID | Title | Status |
|----|-------|--------|
`,
        overwrite,
        fileSystem
      );
    }

    // Create rule file directory
    let rulesDirPath: string;
    if (ruleFormat === "cursor") {
      rulesDirPath = path.join(repoPath, ".cursor", "rules");
    } else {
      rulesDirPath = path.join(repoPath, ".ai", "rules");
    }
    await createDirectoryIfNotExists(rulesDirPath, fileSystem);

    // Create minsky.mdc rule file
    const ruleFilePath = path.join(rulesDirPath, "minsky-workflow.mdc");
    await createFileIfNotExists(ruleFilePath, getMinskyRuleContent(), overwrite, fileSystem);

    // Create index.mdc rule file for categorizing rules
    const indexFilePath = path.join(rulesDirPath, "index.mdc");
    await createFileIfNotExists(indexFilePath, getRulesIndexContent(), overwrite, fileSystem);
  }

  // Setup MCP if enabled
  if (mcp?.enabled !== false) {
    // Default to enabled if not explicitly disabled
    // Create the MCP config file
    const mcpConfig = getMCPConfigContent(mcp);
    const mcpConfigPath = path.join(repoPath, ".cursor", "mcp.json");
    await createFileIfNotExists(mcpConfigPath, mcpConfig, overwrite, fileSystem);

    // Create MCP usage rule
    const rulesDirPath =
      ruleFormat === "cursor"
        ? path.join(repoPath, ".cursor", "rules")
        : path.join(repoPath, ".ai", "rules");

    await createDirectoryIfNotExists(rulesDirPath, fileSystem);

    const mcpRuleFilePath = path.join(rulesDirPath, "mcp-usage.mdc");
    await createFileIfNotExists(mcpRuleFilePath, getMCPRuleContent(), overwrite, fileSystem);
  }
}

/**
 * Creates a directory and all parent directories if they don't exist
 */
async function createDirectoryIfNotExists(
  dirPath: string,
  fileSystem: FileSystem = fs
): Promise<void> {
  if (!fileSystem.existsSync(dirPath)) {
    fileSystem.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Creates a file if it doesn't exist, throws an error if it does unless overwrite is true
 */
async function createFileIfNotExists(
  filePath: string,
  _content: string,
  overwrite = false,
  fileSystem: FileSystem = fs
): Promise<void> {
  if (fileSystem.existsSync(filePath)) {
    if (!overwrite) {
      throw new Error(`File already exists: ${filePath}`);
    }
    // If overwrite is true, we'll proceed and overwrite the existing file
  }

  // Ensure the directory exists
  const dirPath = path.dirname(filePath);
  await createDirectoryIfNotExists(dirPath, fileSystem);

  // Write the file
  fileSystem.writeFileSync(filePath, _content);
}

/**
 * Returns the content for the minsky.mdc rule file
 */
function getMinskyRuleContent(): string {
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
3. Enter the session directory (\`cd $(minsky session dir session-name)\`)

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
function getRulesIndexContent(): string {
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
2. **robust-error-handling** & **dont-ignore-errors** - Verify error handling
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
- **robust-error-handling** and **dont-ignore-errors** ensure comprehensive error management
- **pr-description-guidelines** and **changelog** both contribute to documentation of changes

This index serves as a guide to help you understand which rules are relevant to different aspects of working with Minsky and how they interact with each other.`;
}

/**
 * Returns the content for the MCP config file
 */
function getMCPConfigContent(mcpOptions?: InitializeProjectOptions["mcp"]): string {
  const transport = mcpOptions?.transport || "stdio";
  const port = mcpOptions?.port || DEFAULT_DEV_PORT;
  const host = mcpOptions?.host || "localhost";

  // Base configuration for stdio transport
  if (transport === "stdio") {
    return JSON.stringify(
      {
        mcpServers: {
          "minsky-server": {
            _command: "minsky",
            _args: ["mcp", "start", "--stdio"],
          },
        },
      },
      null,
      2
    );
  }

  // Configuration for SSE transport
  else if (transport === "sse") {
    return JSON.stringify(
      {
        mcpServers: {
          "minsky-server": {
            _command: "minsky",
            _args: ["mcp", "start", "--sse", "--port", String(port), "--host", host],
          },
        },
      },
      null,
      2
    );
  }

  // Configuration for HTTP Stream transport
  else if (transport === "httpStream") {
    return JSON.stringify(
      {
        mcpServers: {
          "minsky-server": {
            _command: "minsky",
            _args: ["mcp", "start", "--http-stream", "--port", String(port), "--host", host],
          },
        },
      },
      null,
      2
    );
  }

  // Default fallback (shouldn't be reached with proper type checking)
  return JSON.stringify(
    {
      mcpServers: {
        "minsky-server": {
          _command: "minsky",
          _args: ["mcp", "start", "--stdio"],
        },
      },
    },
    null,
    2
  );
}

/**
 * Returns the content for the MCP usage rule
 */
function getMCPRuleContent(): string {
  return `# MCP Usage

## Overview

The Model Context Protocol (MCP) provides a standardized way for AI agents to interact with the Minsky CLI, enabling automation and intelligent assistance. This rule explains how to use MCP effectively with Minsky.

## MCP Configuration

Minsky uses MCP to expose its functionality to AI agents. The configuration is stored in \`.cursor/mcp.json\`:

\`\`\`json
{
  "mcpServers": {
    "minsky-server": {
      "command": "minsky",
      "args": ["mcp", "start", "--stdio"]
    }
  }
}
\`\`\`

## Available Tools

Minsky exposes the following tools via MCP:

### Task Management

- \`tasks.list\`: List all tasks
- \`tasks.get\`: Get details of a specific task
- \`tasks.status.get\`: Get the status of a task
- \`tasks.status.set\`: Set the status of a task
- \`tasks.create\`: Create a new task from a specification document

### Session Management

- \`session.list\`: List all sessions
- \`session.get\`: Get details of a specific session
- \`session.start\`: Start a new session
- \`session.commit\`: Commit changes in a session
- \`session.push\`: Push changes in a session

## Usage Examples

### Example: List Tasks via MCP

\`\`\`typescript
// AI can retrieve task information using:
const _tasks = await tools.tasks.list({})
log.agent(_tasks) // Returns JSON array of tasks using structured logging
\`\`\`

### Example: Start a Session via MCP

\`\`\`typescript
// AI can start a session for task #123:
const _result = await tools.session.start({ task: "123", quiet: true })
log.cli(result.message) // Session directory path using structured logging
\`\`\`

## Security Considerations

- MCP servers have access to execute commands on your system
- Review and approve tool calls before allowing execution
- Use environment variables for sensitive configuration values
- For production use, consider network transport security when using SSE or HTTP Stream

## Transport Types

Minsky supports three MCP transport types:

1. **stdio**: Default, runs on local machine only (most secure)
2. **SSE**: Enables network access, supports remote connections
3. **HTTP Stream**: Similar to SSE, with different protocol

For team environments, SSE or HTTP Stream can allow shared access to Minsky tools.

## Best Practices

- Always verify that your MCP configuration file exists before running AI agents
- Use task IDs consistently when referring to tasks through MCP
- Review AI-proposed tool calls before execution
- For web interfaces, prefer SSE transport
- For security-sensitive environments, stick with stdio transport

This rule helps Minsky users configure and leverage the Model Context Protocol effectively.`;
}

/**
 * Test utility for mocking file system operations
 */
export interface FileSystem {
  existsSync: (_path: unknown) => boolean;
  mkdirSync: (_path: unknown) => void;
  writeFileSync: (_path: unknown) => void;
}

/**
 * For testing: initialize a project with a custom filesystem implementation
 */
export async function initializeProjectWithFS(
  _options: InitializeProjectOptions,
  fileSystem: FileSystem
): Promise<void> {
  const { repoPath, backend, ruleFormat, mcp, mcpOnly = false, overwrite = false } = options;

  // Handle different backends
  if (backend === "tasks.md") {
    // Initialize tasks.md backend
    if (!mcpOnly) {
      const tasksFilePath = path.join(repoPath, "process", "tasks.md");
      const tasksDirPath = path.join(repoPath, "process", "tasks");

      // Check if files exist
      if (fileSystem.existsSync(tasksFilePath) && !overwrite) {
        throw new Error(`File already exists: ${tasksFilePath}`);
      }

      // Create directories
      if (!fileSystem.existsSync(tasksDirPath)) {
        fileSystem.mkdirSync(tasksDirPath, { recursive: true });
      }

      // Create tasks.md file
      fileSystem.writeFileSync(tasksFilePath, "# Minsky Tasks\n\n- [ ] Example task\n");
    }

    // Handle rule format based on options
    const rulesDirPath = path.join(repoPath, ruleFormat === "cursor" ? ".cursor" : ".ai", "rules");

    // Create directories for rules
    if (!fileSystem.existsSync(rulesDirPath)) {
      fileSystem.mkdirSync(rulesDirPath, { recursive: true });
    }

    // Create rule files
    if (!mcpOnly) {
      const workflowRulePath = path.join(rulesDirPath, "minsky-workflow.mdc");
      const indexRulePath = path.join(rulesDirPath, "index.mdc");

      if (fileSystem.existsSync(workflowRulePath) && !overwrite) {
        throw new Error(`File already exists: ${workflowRulePath}`);
      }

      fileSystem.writeFileSync(workflowRulePath, getMinskyRuleContent());
      fileSystem.writeFileSync(indexRulePath, getRulesIndexContent());
    }

    // MCP Configuration
    if (mcp?.enabled !== false) {
      const mcpConfigPath = path.join(repoPath, ".cursor", "mcp.json");

      // Create .cursor directory if it doesn't exist (even for generic rule format)
      const cursorDirPath = path.join(repoPath, ".cursor");
      if (!fileSystem.existsSync(cursorDirPath)) {
        fileSystem.mkdirSync(cursorDirPath, { recursive: true });
      }

      if (fileSystem.existsSync(mcpConfigPath) && !overwrite) {
        throw new Error(`File already exists: ${mcpConfigPath}`);
      }

      // Create MCP config file
      fileSystem.writeFileSync(mcpConfigPath, getMCPConfigContent(mcp));

      // Create MCP usage rule
      const mcpRuleFilePath = path.join(rulesDirPath, "mcp-usage.mdc");
      if (!fileSystem.existsSync(mcpRuleFilePath) || overwrite) {
        fileSystem.writeFileSync(mcpRuleFilePath, getMCPRuleContent());
      }
    }
  } else if (backend === "tasks.csv") {
    throw new Error("The tasks.csv backend is not implemented yet.");
  } else {
    throw new Error(`Backend not implemented: ${backend}`);
  }
}
