import { describe, it, expect, mock } from "bun:test";
import type { SessionProviderInterface, SessionRecord } from "./types";
import { SessionMigrationService, type SessionMigrationOptions } from "./migration-command";

// Mock session data for testing
const createMockSessionData = () => {
  const legacySessions: SessionRecord[] = [
    {
      session: "task123",
      repoName: "test-repo-1",
      repoUrl: "https://github.com/test/repo1",
      createdAt: "2024-01-01T00:00:00Z",
      taskId: "123",
    },
    {
      session: "task456",
      repoName: "test-repo-2",
      repoUrl: "https://github.com/test/repo2",
      createdAt: "2024-01-02T00:00:00Z",
      taskId: "456",
    },
    {
      session: "task#789",
      repoName: "test-repo-3",
      repoUrl: "https://github.com/test/repo3",
      createdAt: "2024-01-03T00:00:00Z",
      taskId: "789",
    },
  ];

  const modernSessions: SessionRecord[] = [
    {
      session: "task-md#100",
      repoName: "modern-repo-1",
      repoUrl: "https://github.com/modern/repo1",
      createdAt: "2024-01-04T00:00:00Z",
      taskId: "md#100",
    },
    {
      session: "task-gh#200",
      repoName: "modern-repo-2",
      repoUrl: "https://github.com/modern/repo2",
      createdAt: "2024-01-05T00:00:00Z",
      taskId: "gh#200",
    },
  ];

  const customSessions: SessionRecord[] = [
    {
      session: "custom-session",
      repoName: "custom-repo",
      repoUrl: "https://github.com/custom/repo",
      createdAt: "2024-01-06T00:00:00Z",
      // No taskId - custom session
    },
  ];

  return {
    legacy: legacySessions,
    modern: modernSessions,
    custom: customSessions,
    all: [...legacySessions, ...modernSessions, ...customSessions],
  };
};

// Mock SessionProviderInterface
function createMockSessionDB(initialSessions: SessionRecord[] = []): SessionProviderInterface {
  let sessions = [...initialSessions];

  return {
    listSessions: mock(async () => [...sessions]),
    getSession: mock(
      async (sessionName: string) => sessions.find((s) => s.session === sessionName) || null
    ),
    getSessionByTaskId: mock(
      async (taskId: string) => sessions.find((s) => s.taskId === taskId) || null
    ),
    addSession: mock(async (record: SessionRecord) => {
      sessions.push(record);
    }),
    updateSession: mock(
      async (sessionName: string, updates: Partial<Omit<SessionRecord, "session">>) => {
        const index = sessions.findIndex((s) => s.session === sessionName);
        if (index !== -1) {
          sessions[index] = { ...sessions[index], ...updates };
        }
      }
    ),
    deleteSession: mock(async (sessionName: string) => {
      const index = sessions.findIndex((s) => s.session === sessionName);
      if (index !== -1) {
        sessions.splice(index, 1);
        return true;
      }
      return false;
    }),
    getRepoPath: mock(async () => "/mock/repo/path"),
    getSessionWorkdir: mock(async () => "/mock/session/workdir"),
  };
}

describe("Session Migration Command", () => {
  describe("SessionMigrationService", () => {
    describe("analyzeMigrationNeeds", () => {
      it("should correctly identify sessions needing migration", async () => {
        const mockData = createMockSessionData();
        const sessionDB = createMockSessionDB(mockData.all);
        const migrationService = new SessionMigrationService(sessionDB);

        const analysis = await migrationService.analyzeMigrationNeeds();

        expect(analysis.total).toBe(6); // 3 legacy + 2 modern + 1 custom
        expect(analysis.needsMigration).toBe(3); // Only legacy sessions need migration
        expect(analysis.alreadyMigrated).toBe(2); // Modern sessions with task IDs
      });

      it("should handle empty database", async () => {
        const sessionDB = createMockSessionDB([]);
        const migrationService = new SessionMigrationService(sessionDB);

        const analysis = await migrationService.analyzeMigrationNeeds();

        expect(analysis.total).toBe(0);
        expect(analysis.needsMigration).toBe(0);
        expect(analysis.alreadyMigrated).toBe(0);
      });
    });

    describe("preview migration", () => {
      it("should preview migration without making changes", async () => {
        const mockData = createMockSessionData();
        const sessionDB = createMockSessionDB(mockData.legacy);
        const migrationService = new SessionMigrationService(sessionDB);

        const report = await migrationService.preview();

        // Should identify all legacy sessions for migration
        expect(report.progress.needsMigration).toBe(3);
        expect(report.results).toHaveLength(3);

        // Should not have actually updated database
        expect(sessionDB.updateSession).not.toHaveBeenCalled();

        // Should show what changes would be made
        expect(report.summary.taskIdsUpgraded).toBe(3);
        expect(report.summary.backendsAdded).toBe(3);
        expect(report.summary.legacyIdsPreserved).toBe(3);
      });

      it("should show detailed changes for each session", async () => {
        const mockData = createMockSessionData();
        const sessionDB = createMockSessionDB([mockData.legacy[0]]); // Just one legacy session
        const migrationService = new SessionMigrationService(sessionDB);

        const report = await migrationService.preview();

        expect(report.results).toHaveLength(1);
        const result = report.results[0];

        // Ensure result exists before checking properties
        expect(result).toBeDefined();
        expect(result.success).toBe(true);
        expect(result.original.session).toBe("task123");
        expect(result.migrated?.session).toBe("task-md#123");
        expect(result.migrated?.taskId).toBe("md#123");
        expect(result.migrated?.taskBackend).toBe("md");
        expect(result.migrated?.legacyTaskId).toBe("123");

        expect(result.changes.sessionNameChanged).toBe(true);
        expect(result.changes.taskIdChanged).toBe(true);
        expect(result.changes.backendAdded).toBe(true);
        expect(result.changes.legacyIdPreserved).toBe(true);
      });
    });

    describe("full migration", () => {
      it("should migrate all legacy sessions", async () => {
        const mockData = createMockSessionData();
        const sessionDB = createMockSessionDB(mockData.legacy);
        const migrationService = new SessionMigrationService(sessionDB);

        const report = await migrationService.migrate({
          backup: false, // Skip backup for testing
        });

        // Should have processed all legacy sessions
        expect(report.progress.migrated).toBe(3);
        expect(report.progress.failed).toBe(0);

        // Should have updated database
        expect(sessionDB.updateSession).toHaveBeenCalledTimes(3);

        // Verify specific migrations
        expect(sessionDB.updateSession).toHaveBeenCalledWith(
          "task123",
          expect.objectContaining({
            session: "task-md#123",
            taskId: "md#123",
            taskBackend: "md",
            legacyTaskId: "123",
          })
        );
      });

      it("should handle batch processing", async () => {
        const mockData = createMockSessionData();
        const sessionDB = createMockSessionDB(mockData.legacy);
        const migrationService = new SessionMigrationService(sessionDB);

        const progressUpdates: any[] = [];
        const report = await migrationService.migrate(
          {
            backup: false,
            batchSize: 2, // Process 2 sessions per batch
          },
          (progress) => progressUpdates.push({ ...progress })
        );

        // Should have processed in 2 batches (3 sessions, batch size 2)
        expect(report.progress.totalBatches).toBe(2);

        // Should have received progress updates
        expect(progressUpdates.length).toBeGreaterThan(0);

        // Final result should be successful
        expect(report.progress.migrated).toBe(3);
      });

      it("should create backup before migration", async () => {
        const mockData = createMockSessionData();
        const sessionDB = createMockSessionDB(mockData.legacy);
        const migrationService = new SessionMigrationService(sessionDB);

        // Mock the backup creation
        const originalCreateBackup = migrationService.createBackup;
        const mockCreateBackup = mock(async () => "backup-123.json");
        migrationService.createBackup = mockCreateBackup;

        const report = await migrationService.migrate({ backup: true });

        expect(mockCreateBackup).toHaveBeenCalled();
        expect(report.backupPath).toBe("backup-123.json");
      });
    });

    describe("filtering", () => {
      it("should filter by task backend", async () => {
        const mixedSessions: SessionRecord[] = [
          {
            session: "task123",
            repoName: "repo1",
            repoUrl: "https://github.com/test/repo1",
            createdAt: "2024-01-01T00:00:00Z",
            taskId: "123", // Will be detected as 'md' backend
          },
          {
            session: "task-gh#456",
            repoName: "repo2",
            repoUrl: "https://github.com/test/repo2",
            createdAt: "2024-01-02T00:00:00Z",
            taskId: "gh#456", // Already 'gh' backend
          },
        ];

        const sessionDB = createMockSessionDB(mixedSessions);
        const migrationService = new SessionMigrationService(sessionDB);

        const report = await migrationService.preview({
          filter: { taskBackend: "md" },
        });

        // Should only process the session that would become 'md' backend
        expect(report.results).toHaveLength(1);
        expect(report.results[0].original.session).toBe("task123");
      });

      it("should filter by date", async () => {
        const sessionsByDate: SessionRecord[] = [
          {
            session: "task123",
            repoName: "repo1",
            repoUrl: "https://github.com/test/repo1",
            createdAt: "2024-01-01T00:00:00Z", // Before cutoff
            taskId: "123",
          },
          {
            session: "task456",
            repoName: "repo2",
            repoUrl: "https://github.com/test/repo2",
            createdAt: "2024-01-15T00:00:00Z", // After cutoff
            taskId: "456",
          },
        ];

        const sessionDB = createMockSessionDB(sessionsByDate);
        const migrationService = new SessionMigrationService(sessionDB);

        const report = await migrationService.preview({
          filter: { createdBefore: "2024-01-10T00:00:00Z" },
        });

        // Should only process sessions created before the cutoff
        expect(report.results).toHaveLength(1);
        expect(report.results[0].original.session).toBe("task123");
      });

      it("should filter by session name pattern", async () => {
        const mockData = createMockSessionData();
        const sessionDB = createMockSessionDB(mockData.legacy);
        const migrationService = new SessionMigrationService(sessionDB);

        const report = await migrationService.preview({
          filter: { sessionPattern: "task\\d{3}$" }, // Match task123, task456, etc.
        });

        // Should match task123 and task456, but not task#789
        expect(report.results).toHaveLength(2);
        expect(report.results.map((r) => r.original.session)).toEqual(
          expect.arrayContaining(["task123", "task456"])
        );
      });
    });

    describe("error handling", () => {
      it("should handle migration errors gracefully", async () => {
        const sessionDB = createMockSessionDB([
          {
            session: "invalid-session",
            repoName: "repo",
            repoUrl: "invalid-url",
            createdAt: "invalid-date", // This might cause issues
            taskId: "123",
          },
        ]);

        const migrationService = new SessionMigrationService(sessionDB);

        // Force an error by mocking the migration logic
        const originalMigrateSession = (migrationService as any).migrateSession;
        (migrationService as any).migrateSession = mock(() => {
          throw new Error("Migration failed");
        });

        const report = await migrationService.migrate({ backup: false });

        expect(report.progress.failed).toBe(1);
        expect(report.results[0].success).toBe(false);
        expect(report.results[0].error).toBe("Migration failed");
      });

      it("should handle database update failures", async () => {
        const mockData = createMockSessionData();
        const sessionDB = createMockSessionDB(mockData.legacy);

        // Mock updateSession to fail
        sessionDB.updateSession = mock(async () => {
          throw new Error("Database update failed");
        });

        const migrationService = new SessionMigrationService(sessionDB);

        // Should not throw, but should handle the error
        await expect(migrationService.migrate({ backup: false })).resolves.not.toThrow();
      });
    });

    describe("rollback functionality", () => {
      it("should support rollback", async () => {
        const sessionDB = createMockSessionDB([]);
        const migrationService = new SessionMigrationService(sessionDB);

        const success = await migrationService.rollback("backup-123.json");
        expect(success).toBe(true);
      });
    });

    describe("edge cases", () => {
      it("should handle sessions with no task ID", async () => {
        const customSessions: SessionRecord[] = [
          {
            session: "custom-session",
            repoName: "repo",
            repoUrl: "https://github.com/test/repo",
            createdAt: "2024-01-01T00:00:00Z",
            // No taskId
          },
        ];

        const sessionDB = createMockSessionDB(customSessions);
        const migrationService = new SessionMigrationService(sessionDB);

        const report = await migrationService.preview();

        // Should not try to migrate sessions without task IDs
        expect(report.results).toHaveLength(0);
        expect(report.progress.needsMigration).toBe(0);
      });

      it("should handle empty filter results", async () => {
        const mockData = createMockSessionData();
        const sessionDB = createMockSessionDB(mockData.legacy);
        const migrationService = new SessionMigrationService(sessionDB);

        const report = await migrationService.preview({
          filter: { sessionPattern: "nonexistent-pattern" },
        });

        expect(report.results).toHaveLength(0);
        expect(report.executionTime).toBeGreaterThanOrEqual(0);
      });
    });
  });
});
