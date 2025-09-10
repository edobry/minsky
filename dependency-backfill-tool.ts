#!/usr/bin/env bun
/**
 * Task Dependency Backfill Tool
 *
 * Systematically finds free-form dependency references in task specs,
 * creates formal dependency links, and cleans up the specs.
 */

import { createConfiguredTaskService } from "./src/domain/tasks/taskService";
import { TaskGraphService } from "./src/domain/tasks/task-graph-service";
import { PersistenceService } from "./src/domain/persistence/service";
import { initializeConfiguration, CustomConfigFactory } from "./src/domain/configuration";

interface TaskDependencyReference {
  taskId: string;
  referencedTaskId: string;
  referenceText: string;
  context: string;
  dependencyType: "prerequisite" | "related" | "optional";
  startIndex: number;
  endIndex: number;
}

interface BackfillResult {
  processedTasks: number;
  foundReferences: TaskDependencyReference[];
  createdDependencies: Array<{ from: string; to: string; type: string }>;
  cleanedSpecs: Array<{ taskId: string; originalLength: number; newLength: number }>;
  errors: Array<{ taskId: string; error: string }>;
}

class DependencyBackfillTool {
  private taskService: any;
  private graphService: TaskGraphService;
  private results: BackfillResult = {
    processedTasks: 0,
    foundReferences: [],
    createdDependencies: [],
    cleanedSpecs: [],
    errors: [],
  };

  constructor(taskService: any, graphService: TaskGraphService) {
    this.taskService = taskService;
    this.graphService = graphService;
  }

  /**
   * Regex patterns to identify task references in different formats
   */
  private readonly TASK_REFERENCE_PATTERNS = [
    // Legacy format: "Task #123"
    {
      pattern: /Task #(\d+)/gi,
      format: (match: string, id: string) => `mt#${id}`,
      contextKeywords: ["depends on", "requires", "prerequisite", "building on", "based on"],
      defaultType: "prerequisite" as const,
    },

    // Qualified IDs: mt#123, md#123, gh#123, etc.
    {
      pattern: /(mt|md|gh|json)#(\d+)/gi,
      format: (match: string) => match.toLowerCase(),
      contextKeywords: ["depends on", "requires", "prerequisite", "building on", "based on"],
      defaultType: "prerequisite" as const,
    },

    // Section-based references in Dependencies sections
    {
      pattern: /(?:^|\n)[-\s]*(?:Task #(\d+)|([a-z]+)#(\d+))(?::.*)?$/gim,
      format: (match: string, legacyId?: string, prefix?: string, id?: string) => {
        if (legacyId) return `mt#${legacyId}`;
        return `${prefix}#${id}`.toLowerCase();
      },
      contextKeywords: [],
      defaultType: "prerequisite" as const,
      sectionContext: true,
    },
  ];

  /**
   * Context analyzers to determine dependency type from surrounding text
   */
  private readonly CONTEXT_ANALYZERS = [
    {
      keywords: ["must be completed", "prerequisite", "blocked by", "depends on", "requires"],
      type: "prerequisite" as const,
    },
    {
      keywords: ["building on", "extends", "uses", "leverages", "based on"],
      type: "prerequisite" as const,
    },
    {
      keywords: ["related to", "see also", "similar to", "connected to"],
      type: "related" as const,
    },
    {
      keywords: ["ideally", "optionally", "can benefit", "would help"],
      type: "optional" as const,
    },
  ];

  /**
   * Find all task references in a spec content
   */
  private findTaskReferences(taskId: string, content: string): TaskDependencyReference[] {
    const references: TaskDependencyReference[] = [];

    for (const pattern of this.TASK_REFERENCE_PATTERNS) {
      let match: RegExpExecArray | null;

      while ((match = pattern.pattern.exec(content)) !== null) {
        const fullMatch = match[0];
        const referencedTaskId = pattern.format(fullMatch, ...match.slice(1));

        // Skip self-references
        if (referencedTaskId === taskId) continue;

        // Get context around the match
        const startIndex = Math.max(0, match.index - 100);
        const endIndex = Math.min(content.length, match.index + fullMatch.length + 100);
        const context = content.slice(startIndex, endIndex);

        // Determine dependency type from context
        const dependencyType = this.analyzeDependencyType(context);

        references.push({
          taskId,
          referencedTaskId,
          referenceText: fullMatch,
          context,
          dependencyType,
          startIndex: match.index,
          endIndex: match.index + fullMatch.length,
        });
      }

      // Reset regex lastIndex for next use
      pattern.pattern.lastIndex = 0;
    }

    return references;
  }

  /**
   * Analyze context to determine dependency type
   */
  private analyzeDependencyType(context: string): "prerequisite" | "related" | "optional" {
    const lowerContext = context.toLowerCase();

    for (const analyzer of this.CONTEXT_ANALYZERS) {
      for (const keyword of analyzer.keywords) {
        if (lowerContext.includes(keyword)) {
          return analyzer.type;
        }
      }
    }

    // Check if in a Dependencies/Prerequisites section
    if (lowerContext.includes("dependencies") || lowerContext.includes("prerequisites")) {
      return "prerequisite";
    }

    // Default to related for ambiguous references
    return "related";
  }

  /**
   * Verify that a referenced task actually exists
   */
  private async verifyTaskExists(taskId: string): Promise<boolean> {
    try {
      const task = await this.taskService.getTask(taskId);
      return !!task;
    } catch {
      return false;
    }
  }

  /**
   * Process a single task to find and extract dependencies
   */
  private async processTask(task: any): Promise<void> {
    try {
      // Get full task spec content
      let specContent: string;

      try {
        const specResult = await this.taskService.getTaskSpecContent(task.id);
        specContent = specResult.content || "";
      } catch {
        // If no spec content, skip this task
        return;
      }

      if (!specContent.trim()) {
        return;
      }

      // Find all task references in the spec
      const references = this.findTaskReferences(task.id, specContent);

      if (references.length === 0) {
        return;
      }

      // Validate referenced tasks exist
      const validReferences: TaskDependencyReference[] = [];
      for (const ref of references) {
        const exists = await this.verifyTaskExists(ref.referencedTaskId);
        if (exists) {
          validReferences.push(ref);
          this.results.foundReferences.push(ref);
        } else {
          // Log warning about missing referenced task
          console.warn(`⚠️  Task ${task.id} references non-existent task ${ref.referencedTaskId}`);
        }
      }

      // Create formal dependency links
      for (const ref of validReferences) {
        try {
          // For now, treat all as prerequisite dependencies
          // TODO: Use ref.dependencyType when TaskGraphService supports types
          const result = await this.graphService.addDependency(ref.taskId, ref.referencedTaskId);

          if (result.created) {
            this.results.createdDependencies.push({
              from: ref.taskId,
              to: ref.referencedTaskId,
              type: ref.dependencyType,
            });
          }
        } catch (error) {
          this.results.errors.push({
            taskId: task.id,
            error: `Failed to create dependency ${ref.taskId} -> ${ref.referencedTaskId}: ${error.message}`,
          });
        }
      }

      // Clean up the spec by removing redundant dependency text
      await this.cleanupTaskSpec(task.id, specContent, validReferences);
    } catch (error) {
      this.results.errors.push({
        taskId: task.id,
        error: `Failed to process task: ${error.message}`,
      });
    }

    this.results.processedTasks++;
  }

  /**
   * Clean up task spec by removing redundant dependency references
   */
  private async cleanupTaskSpec(
    taskId: string,
    originalContent: string,
    references: TaskDependencyReference[]
  ): Promise<void> {
    let cleanedContent = originalContent;

    // Remove entire formal dependency sections that are now redundant
    const dependencySectionPatterns = [
      /## Dependencies\s*\n(\s*- [^\n]*(?:Task #\d+|mt#\d+|md#\d+)[^\n]*\n)+/gi,
      /## Prerequisites\s*\n(\s*- [^\n]*(?:Task #\d+|mt#\d+|md#\d+)[^\n]*\n)+/gi,
      /### Dependencies\s*\n(\s*- [^\n]*(?:Task #\d+|mt#\d+|md#\d+)[^\n]*\n)+/gi,
      /### Prerequisites\s*\n(\s*- [^\n]*(?:Task #\d+|mt#\d+|md#\d+)[^\n]*\n)+/gi,
    ];

    // Remove formal dependency sections
    for (const pattern of dependencySectionPatterns) {
      const matches = [...cleanedContent.matchAll(pattern)];
      for (const match of matches.reverse()) {
        // Process in reverse to avoid index issues
        const sectionContent = match[0];

        // Only remove if it's purely task references (no other dependencies)
        const hasOnlyTaskRefs =
          /^##?\s+(Dependencies|Prerequisites)\s*\n(\s*- [^\n]*(?:Task #\d+|mt#\d+|md#\d+)[^\n]*\n?)+$/im.test(
            sectionContent
          );

        if (hasOnlyTaskRefs) {
          cleanedContent =
            cleanedContent.slice(0, match.index) +
            cleanedContent.slice(match.index + match[0].length);
          console.log(`    🧹 Removed formal dependency section from ${taskId}`);
        }
      }
    }

    // Remove individual dependency lines in lists
    const taskRefLinePattern =
      /^\s*[-*]\s+[^\n]*(?:Task #\d+|mt#\d+|md#\d+)[^\n]*(?:\([^)]*\))?\s*$/gim;
    cleanedContent = cleanedContent.replace(taskRefLinePattern, "");

    // Clean up empty sections and extra whitespace
    cleanedContent = cleanedContent.replace(/\n\n\n+/g, "\n\n"); // Collapse multiple blank lines
    cleanedContent = cleanedContent.replace(/\n\s*\n\s*##/g, "\n\n##"); // Fix section spacing

    // Only update if content changed
    if (cleanedContent.trim() !== originalContent.trim()) {
      try {
        await this.taskService.updateTask(taskId, { spec: cleanedContent.trim() });
        this.results.cleanedSpecs.push({
          taskId,
          originalLength: originalContent.length,
          newLength: cleanedContent.length,
        });
        console.log(
          `    ✅ Cleaned ${originalContent.length - cleanedContent.length} characters from ${taskId} spec`
        );
      } catch (error) {
        this.results.errors.push({
          taskId,
          error: `Failed to update spec: ${error.message}`,
        });
      }
    }
  }

  /**
   * Check if a reference is in descriptive/narrative context vs formal dependency list
   */
  private isDescriptiveContext(context: string): boolean {
    // Look for narrative indicators
    const narrativeIndicators = [
      "builds on",
      "based on",
      "similar to",
      "extends",
      "uses concepts from",
      "related to",
      "inspired by",
    ];

    const lowerContext = context.toLowerCase();
    return narrativeIndicators.some((indicator) => lowerContext.includes(indicator));
  }

  /**
   * Check if a line is a standalone dependency reference (can be safely removed)
   */
  private isStandaloneDependencyLine(line: string): boolean {
    const trimmed = line.trim();

    // Check if it's a simple list item with just a task reference
    const simpleListItem = /^[-*]\s*(Task #\d+|[a-z]+#\d+)(?:\s*:.*)?$/i;

    return simpleListItem.test(trimmed);
  }

  /**
   * Main execution function
   */
  async execute(dryRun: boolean = false): Promise<BackfillResult> {
    console.log("🔍 Starting task dependency backfill process...\n");

    // Get all TODO tasks from all backends
    const todoTasks = await this.taskService.listTasks({ status: "TODO" });
    console.log(`📋 Found ${todoTasks.length} TODO tasks to analyze\n`);

    if (dryRun) {
      console.log("🧪 DRY RUN MODE - No changes will be made\n");
    }

    // Process each task
    for (const task of todoTasks) {
      console.log(`📝 Processing ${task.id}: ${task.title.substring(0, 60)}...`);

      if (!dryRun) {
        await this.processTask(task);
      } else {
        // In dry run, just find references without creating dependencies
        try {
          const specResult = await this.taskService.getTaskSpecContent(task.id);
          const specContent = specResult.content || "";
          const references = this.findTaskReferences(task.id, specContent);
          this.results.foundReferences.push(...references);
          this.results.processedTasks++;
        } catch {
          // Skip tasks without specs in dry run
        }
      }
    }

    return this.results;
  }

  /**
   * Print comprehensive results
   */
  printResults(): void {
    console.log(`\n${"=".repeat(60)}`);
    console.log("📊 DEPENDENCY BACKFILL RESULTS");
    console.log("=".repeat(60));

    console.log(`📝 Tasks processed: ${this.results.processedTasks}`);
    console.log(`🔗 References found: ${this.results.foundReferences.length}`);
    console.log(`✅ Dependencies created: ${this.results.createdDependencies.length}`);
    console.log(`🧹 Specs cleaned: ${this.results.cleanedSpecs.length}`);
    console.log(`❌ Errors encountered: ${this.results.errors.length}`);

    if (this.results.foundReferences.length > 0) {
      console.log("\n🔍 Found References:");
      for (const ref of this.results.foundReferences) {
        console.log(`  ${ref.taskId} → ${ref.referencedTaskId} (${ref.dependencyType})`);
        console.log(`    Text: "${ref.referenceText}"`);
        console.log(`    Context: "${ref.context.substring(0, 100)}..."`);
      }
    }

    if (this.results.createdDependencies.length > 0) {
      console.log("\n✅ Created Dependencies:");
      for (const dep of this.results.createdDependencies) {
        console.log(`  ${dep.from} depends on ${dep.to} (${dep.type})`);
      }
    }

    if (this.results.cleanedSpecs.length > 0) {
      console.log("\n🧹 Cleaned Specs:");
      for (const cleanup of this.results.cleanedSpecs) {
        const reduction = (
          ((cleanup.originalLength - cleanup.newLength) / cleanup.originalLength) *
          100
        ).toFixed(1);
        console.log(
          `  ${cleanup.taskId}: ${cleanup.originalLength} → ${cleanup.newLength} chars (${reduction}% reduction)`
        );
      }
    }

    if (this.results.errors.length > 0) {
      console.log("\n❌ Errors:");
      for (const error of this.results.errors) {
        console.log(`  ${error.taskId}: ${error.error}`);
      }
    }

    console.log("\n🎯 Summary:");
    console.log(`  • Analyzed ${this.results.processedTasks} TODO tasks`);
    console.log(`  • Found ${this.results.foundReferences.length} dependency references`);
    console.log(`  • Created ${this.results.createdDependencies.length} formal dependency links`);
    console.log(`  • Cleaned up ${this.results.cleanedSpecs.length} task specifications`);

    if (this.results.errors.length === 0) {
      console.log("\n✅ Backfill completed successfully!");
    } else {
      console.log(`\n⚠️  Backfill completed with ${this.results.errors.length} errors`);
    }
  }
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  let db: any = null;

  try {
    // Initialize configuration first
    console.log("🔧 Initializing configuration...");
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
      enableCache: true,
      skipValidation: true,
    });

    // Initialize services
    console.log("🚀 Initializing task services...");

    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      // No backend specified = multi-backend mode to access all tasks
    });

    // Initialize TaskGraphService with database
    // PersistenceService should already be initialized at application startup
    const persistence = PersistenceService.getProvider();
    db = await persistence.getDatabaseConnection();
    const graphService = new TaskGraphService(db);

    console.log("✅ Services initialized successfully\n");

    // Create and run the backfill tool
    const tool = new DependencyBackfillTool(taskService, graphService);
    const results = await tool.execute(isDryRun);

    // Print results
    tool.printResults();

    // If this was a dry run, explain next steps
    if (isDryRun) {
      console.log("\n💡 To apply these changes, run:");
      console.log("   bun run dependency-backfill-tool.ts");
    }
  } catch (error) {
    console.error("\n❌ Backfill failed:", error.message);
    process.exit(1);
  } finally {
    // Clean up database connections to allow process to exit
    if (db && typeof db.end === "function") {
      try {
        await db.end();
      } catch (closeError) {
        console.warn("Warning: Error closing database connection:", closeError.message);
      }
    }

    // Force exit to prevent hanging
    process.exit(0);
  }
}

// Run if called directly
if (import.meta.main) {
  main();
}
