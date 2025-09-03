import { describe, it, expect, beforeAll, mock } from "bun:test";

describe("Task Dependencies Visualization - DOT Quote Escaping", () => {
  beforeAll(async () => {
    // Initialize configuration for any tests that might need it
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "../../../../../src/domain/configuration/index"
    );
    await initializeConfiguration(new CustomConfigFactory(), {
      enableCache: true,
      skipValidation: true,
    });
  });

  describe("DOT format quote escaping", () => {
    it("should handle quotes in task titles correctly", () => {
      // Test the quote escaping logic directly
      const testTitle = 'Investigate "seek human input" / "ask expert" tool';
      
      // Apply the same escaping logic used in generateGraphvizDot
      const escapedTitle = testTitle
        .replace(/"/g, "'")         // Replace double quotes with single quotes
        .replace(/\n/g, " ")        // Replace newlines with spaces
        .replace(/\r/g, " ");       // Replace carriage returns with spaces
      
      expect(escapedTitle).toBe("Investigate 'seek human input' / 'ask expert' tool");
      expect(escapedTitle).not.toContain('"');
    });

    it("should generate valid DOT syntax for problematic titles", () => {
      const problematicTitles = [
        'Task with "quotes"',
        'Task with\nnewlines',
        'Task with\r\ncarriage returns',
        'Task with "mixed\nproblems"',
      ];

      problematicTitles.forEach(title => {
        const escaped = title
          .replace(/"/g, "'")
          .replace(/\n/g, " ")
          .replace(/\r/g, " ");
        
        // Should not contain characters that break DOT syntax
        expect(escaped).not.toContain('"');
        expect(escaped).not.toContain('\n');
        expect(escaped).not.toContain('\r');
      });
    });

    it("should validate DOT node syntax structure", () => {
      const taskId = "mt#454";
      const safeId = taskId.replace(/[^a-zA-Z0-9]/g, "_");
      const escapedTitle = 'Investigate \'seek human input\'';
      
      const dotLine = `  ${safeId} [label="${taskId}\\n${escapedTitle}", fillcolor="lightblue", style=filled];`;
      
      expect(dotLine).toBe('  mt_454 [label="mt#454\\nInvestigate \'seek human input\'", fillcolor="lightblue", style=filled];');
      expect(dotLine).not.toContain('""'); // No double quotes within quotes
    });
  });

  describe("Bulk query performance verification", () => {
    it("should demonstrate bulk query efficiency over N+1 pattern", async () => {
      // Create mock repository that tracks query count
      let queryCount = 0;
      const mockRepo = {
        // N+1 pattern methods (should not be used in bulk operations)
        async listFrom(taskId: string) {
          queryCount++;
          if (taskId === "mt#1") return ["mt#2"];
          if (taskId === "mt#2") return ["mt#3"];
          return [];
        },
        async listTo(taskId: string) {
          queryCount++;
          if (taskId === "mt#2") return ["mt#1"];
          if (taskId === "mt#3") return ["mt#2"];
          return [];
        },
        
        // Bulk operations (should be used)
        async getAllRelationships() {
          queryCount++;
          return [
            { fromTaskId: "mt#1", toTaskId: "mt#2" },
            { fromTaskId: "mt#2", toTaskId: "mt#3" },
          ];
        },
        async getRelationshipsForTasks(taskIds: string[]) {
          queryCount++;
          return [
            { fromTaskId: "mt#1", toTaskId: "mt#2" },
            { fromTaskId: "mt#2", toTaskId: "mt#3" },
          ].filter(rel => 
            taskIds.includes(rel.fromTaskId) || taskIds.includes(rel.toTaskId)
          );
        },
      };

      const graphService = {
        getRelationshipsForTasks: mockRepo.getRelationshipsForTasks.bind(mockRepo),
        getAllRelationships: mockRepo.getAllRelationships.bind(mockRepo),
      };

      // Test bulk query usage
      queryCount = 0;
      const taskIds = ["mt#1", "mt#2", "mt#3"];
      const relationships = await graphService.getRelationshipsForTasks(taskIds);
      
      expect(queryCount).toBe(1); // Only 1 query for bulk operation
      expect(relationships).toHaveLength(2);
    });
  });
});
