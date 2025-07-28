/**
 * Task Service Mock Fixer
 *
 * This codemod fixes task service mocking issues by:
 * 1. Finding test files that use specific task IDs (123, 124, etc.)
 * 2. Adding corresponding mock task data to those files
 * 3. Ensuring the mock task service returns the expected tasks
 */
import { Project, SourceFile, SyntaxKind } from "ts-morph";
import { SimplifiedCodemodBase } from "./utils/codemod-framework";

export class TaskServiceMockFixer extends SimplifiedCodemodBase {
  constructor() {
    super("TaskServiceMockFixer", {
      description: "Fixes task service mocking issues by adding proper mock task data",
      explanation: "Ensures test files have corresponding mock tasks for the task IDs they test",
    });
  }

  protected async analyzeFile(sourceFile: SourceFile): Promise<boolean> {
    // Only process test files that likely have task service mocking issues
    if (!sourceFile.getFilePath().includes(".test.ts")) {
      return false;
    }

    const fileText = sourceFile.getFullText();

    // Look for signs of task service mocking issues
    const hasTaskServiceMock = fileText.includes("taskService") || fileText.includes("TaskService");
    const hasTaskIdReferences = /task.*(?:123|124|125|266|160|170)/i.test(fileText);
    const hasTaskNotFoundError = fileText.includes("Task not found");

    return hasTaskServiceMock && hasTaskIdReferences;
  }

  protected async transformFile(sourceFile: SourceFile): Promise<void> {
    const fileText = sourceFile.getFullText();

    // Extract task IDs mentioned in the test
    const taskIdMatches = fileText.match(/(?:task.*?|taskId.*?)(\d+)/gi);
    const usedTaskIds = new Set<string>();

    if (taskIdMatches) {
      for (const match of taskIdMatches) {
        const idMatch = match.match(/(\d+)/);
        if (idMatch) {
          usedTaskIds.add(idMatch[1]);
        }
      }
    }

    if (usedTaskIds.size === 0) return;

    console.log(
      `Found task IDs in ${sourceFile.getBaseName()}: ${Array.from(usedTaskIds).join(", ")}`
    );

    // Generate mock task data for each used task ID
    const mockTasks = Array.from(usedTaskIds)
      .map(
        (taskId) => `
    {
      id: "${taskId}",
      title: "Test Task ${taskId}",
      status: "TODO" as const,
      description: "Mock task for testing",
      metadata: {},
      spec: {
        id: "${taskId}",
        title: "Test Task ${taskId}",
        description: "Mock task for testing"
      }
    }`
      )
      .join(",");

    // Find where to insert the mock task setup
    const setupPattern = /beforeEach\s*\(\s*async\s*\(\s*\)\s*=>\s*{([^}]+)}/;
    const match = fileText.match(setupPattern);

    if (match) {
      // Add mock task setup to existing beforeEach
      const mockTaskServiceSetup = `
        // Mock task service to return test tasks
        const mockTasks = [${mockTasks}];
        mockTaskService.getTask = mock((taskId: string) => {
          const task = mockTasks.find(t => t.id === taskId || t.id === taskId.replace("#", ""));
          return Promise.resolve(task || null);
        });
        mockTaskService.listTasks = mock(() => Promise.resolve(mockTasks));`;

      const newBeforeEach = match[0].replace("}", mockTaskServiceSetup + "\n    }");
      sourceFile.replaceWithText(fileText.replace(setupPattern, newBeforeEach));

      console.log(`Added mock task data for IDs: ${Array.from(usedTaskIds).join(", ")}`);
    }
  }
}

// Create and export codemod instance
export function createCodemod() {
  return new TaskServiceMockFixer();
}

// Allow running directly from command line
if (require.main === module) {
  const codemod = createCodemod() as any;

  // Check if argument is directory
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: bun task-service-mock-fixer.ts <path-or-directory>");
    process.exit(1);
  }

  codemod.run(args);
}
