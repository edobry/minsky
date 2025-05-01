import fs from "fs";
import type { PathLike } from "fs";
import path from "path";

export interface InitializeProjectOptions {
  repoPath: string;
  backend: "tasks.md" | "tasks.csv";
  ruleFormat: "cursor" | "generic";
}

/**
 * Creates directories if they don't exist, and errors if files already exist
 */
export async function initializeProject({
  repoPath,
  backend,
  ruleFormat,
}: InitializeProjectOptions): Promise<void> {
  // Check if backend is implemented
  if (backend === "tasks.csv") {
    throw new Error("The tasks.csv backend is not implemented yet.");
  }

  // Create process/tasks directory structure
  const tasksDir = path.join(repoPath, "process", "tasks");
  await createDirectoryIfNotExists(tasksDir);

  // Initialize the tasks backend
  if (backend === "tasks.md") {
    const tasksFilePath = path.join(repoPath, "process", "tasks.md");
    await createFileIfNotExists(
      tasksFilePath,
      `# Minsky Tasks

## Task List

| ID | Title | Status |
|----|-------|--------|
`
    );
  }

  // Create rule file directory
  let rulesDirPath: string;
  if (ruleFormat === "cursor") {
    rulesDirPath = path.join(repoPath, ".cursor", "rules");
  } else {
    rulesDirPath = path.join(repoPath, ".ai", "rules");
  }
  await createDirectoryIfNotExists(rulesDirPath);

  // Create minsky.mdc rule file
  const ruleFilePath = path.join(rulesDirPath, "minsky-workflow.mdc");
  await createFileIfNotExists(ruleFilePath, getMinskyRuleContent());
}

/**
 * Creates a directory and all parent directories if they don't exist
 */
async function createDirectoryIfNotExists(dirPath: string): Promise<void> {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Creates a file if it doesn't exist, throws an error if it does
 */
async function createFileIfNotExists(filePath: string, content: string): Promise<void> {
  if (fs.existsSync(filePath)) {
    throw new Error(`File already exists: ${filePath}`);
  }
  
  // Ensure the directory exists
  const dirPath = path.dirname(filePath);
  await createDirectoryIfNotExists(dirPath);
  
  // Write the file
  fs.writeFileSync(filePath, content);
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
 * Test utility for mocking file system operations
 */
export interface FileSystem {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, content: string) => void;
}

/**
 * For testing: initialize a project with a custom filesystem implementation
 */
export async function initializeProjectWithFS(
  options: InitializeProjectOptions,
  fileSystem: FileSystem
): Promise<void> {
  // Store original fs functions
  const originalExistsSync = fs.existsSync;
  const originalMkdirSync = fs.mkdirSync;
  const originalWriteFileSync = fs.writeFileSync;

  try {
    // Replace with mock functions
    // Need to use any to bypass TypeScript's type checking for tests
    (fs.existsSync as any) = fileSystem.existsSync;
    (fs.mkdirSync as any) = fileSystem.mkdirSync;
    (fs.writeFileSync as any) = fileSystem.writeFileSync;

    // Run the initialization
    await initializeProject(options);
  } finally {
    // Restore original fs functions
    fs.existsSync = originalExistsSync;
    fs.mkdirSync = originalMkdirSync;
    fs.writeFileSync = originalWriteFileSync;
  }
} 
