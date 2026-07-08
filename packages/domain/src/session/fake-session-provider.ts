/**
 * FakeSessionProvider — in-memory test double for SessionProviderInterface.
 *
 * Follows the canonical FakeX pattern established in
 * `src/domain/persistence/fake-persistence-provider.ts` and continued in
 * `src/domain/tasks/fake-task-service.ts`: a real class implementing the
 * typed DI interface, holding state in memory, with zero external I/O.
 *
 * Hermetic by construction: no filesystem, no DB, no network.
 *
 * Uses `validateQualifiedTaskId` for taskId normalization to match the
 * real SessionDbAdapter behavior — tests that look up sessions by task
 * id with different qualifiers (`md#42` vs `42`) get consistent results.
 *
 * Default behavior mirrors the former `createMockSessionProvider` factory
 * from `src/utils/test-utils/dependencies.ts` (now deleted):
 *   - listSessions → returns all stored sessions, honoring the same filter
 *     options the real DrizzleSessionRepository applies (taskId, repoName,
 *     statusNotIn, projectScope, createdAfter/createdBefore, limit/offset —
 *     mt#2697; previously `options` was silently ignored, which masked the
 *     project-scope-vs-unscoped divergence between session.list and the
 *     session.start "already in use" check in every test using this fake)
 *   - getSession → looks up by exact session name match
 *   - getSessionByTaskId → uses validateQualifiedTaskId normalization
 *   - addSession → stores the record in memory
 *   - updateSession → merges updates into stored record
 *   - deleteSession → removes from store, returns true if existed
 *   - getRepoPath → returns "/mock/repo/path"
 *   - getSessionWorkdir → returns "/mock/session/workdir"
 *
 * @see src/domain/persistence/fake-persistence-provider.ts
 * @see src/domain/tasks/fake-task-service.ts
 */

import type { SessionProviderInterface, SessionRecord, SessionListOptions } from "./types";
import { validateQualifiedTaskId } from "../tasks/task-id-utils";
import { isAllProjects } from "../project/scope";

export class FakeSessionProvider implements SessionProviderInterface {
  private readonly store = new Map<string, SessionRecord>();
  private readonly repoPath: string;
  private readonly sessionWorkdir: string;

  constructor(
    options: {
      initialSessions?: SessionRecord[];
      repoPath?: string;
      sessionWorkdir?: string;
    } = {}
  ) {
    this.repoPath = options.repoPath ?? "/mock/repo/path";
    this.sessionWorkdir = options.sessionWorkdir ?? "/mock/session/workdir";
    for (const record of options.initialSessions ?? []) {
      this.store.set(record.sessionId, record);
    }
  }

  async listSessions(options?: SessionListOptions): Promise<SessionRecord[]> {
    let results = Array.from(this.store.values());

    if (options?.taskId) {
      let normalizedTaskId: string;
      try {
        normalizedTaskId = validateQualifiedTaskId(options.taskId) ?? options.taskId;
      } catch {
        normalizedTaskId = options.taskId;
      }
      results = results.filter((r) => r.taskId === normalizedTaskId);
    }

    if (options?.repoName) {
      results = results.filter((r) => r.repoName === options.repoName);
    }

    if (options?.statusNotIn && options.statusNotIn.length > 0) {
      const excluded = new Set(options.statusNotIn);
      results = results.filter((r) => !r.status || !excluded.has(r.status));
    }

    if (options?.projectScope && !isAllProjects(options.projectScope)) {
      // Mirrors the real Postgres `eq(project_id, scope)` condition: rows with
      // a null/undefined project_id never match a specific scope.
      results = results.filter((r) => r.projectId === options.projectScope);
    }

    if (options?.createdAfter) {
      const after = new Date(options.createdAfter).getTime();
      results = results.filter((r) => new Date(r.createdAt).getTime() >= after);
    }

    if (options?.createdBefore) {
      const before = new Date(options.createdBefore).getTime();
      results = results.filter((r) => new Date(r.createdAt).getTime() <= before);
    }

    if (typeof options?.offset === "number" && options.offset > 0) {
      results = results.slice(options.offset);
    }

    if (typeof options?.limit === "number") {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  async getSession(session: string): Promise<SessionRecord | null> {
    return this.store.get(session) ?? null;
  }

  async getSessionByTaskId(taskId: string): Promise<SessionRecord | null> {
    const normalized = validateQualifiedTaskId(taskId);
    if (!normalized) return null;
    for (const record of this.store.values()) {
      if (!record.taskId) continue;
      if (validateQualifiedTaskId(record.taskId) === normalized) return record;
    }
    return null;
  }

  async addSession(record: SessionRecord): Promise<void> {
    this.store.set(record.sessionId, record);
  }

  async updateSession(
    session: string,
    updates: Partial<Omit<SessionRecord, "session">>
  ): Promise<void> {
    const existing = this.store.get(session);
    if (existing) {
      this.store.set(session, { ...existing, ...updates });
    }
  }

  async deleteSession(session: string): Promise<boolean> {
    return this.store.delete(session);
  }

  async getRepoPath(_record: SessionRecord | Record<string, unknown>): Promise<string> {
    return this.repoPath;
  }

  async getSessionWorkdir(_sessionId: string): Promise<string> {
    return this.sessionWorkdir;
  }
}
