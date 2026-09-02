/**
 * FakeWorkspaceUtils — in-memory test double for WorkspaceUtilsInterface.
 *
 * Follows the canonical FakeX pattern established in
 * `packages/domain/src/persistence/fake-persistence-provider.ts` and continued in
 * `packages/domain/src/tasks/fake-task-service.ts`, `packages/domain/src/git/fake-git-service.ts`,
 * and `packages/domain/src/session/fake-session-provider.ts`: a real class implementing
 * the typed DI interface with zero external I/O.
 *
 * Hermetic by construction: no filesystem, no DB, no network.
 *
 * Default behavior mirrors the former inline stub in `createTestDeps`
 * from `src/utils/test-utils/dependencies.ts`:
 *   - isWorkspace → resolves to `true`
 *   - isSessionWorkspace → returns `false`
 *   - getCurrentSession → resolves to `undefined`
 *   - getSessionFromWorkspace → resolves to `undefined`
 *   - resolveWorkspacePath → resolves to `/fake/workspace`
 *
 * @see packages/domain/src/persistence/fake-persistence-provider.ts
 * @see packages/domain/src/session/fake-session-provider.ts
 */

import type { WorkspaceUtilsInterface } from "../workspace";

export class FakeWorkspaceUtils implements WorkspaceUtilsInterface {
  private readonly _isWorkspace: boolean;
  private readonly _workspacePath: string;

  constructor(
    options: {
      isWorkspace?: boolean;
      workspacePath?: string;
    } = {}
  ) {
    this._isWorkspace = options.isWorkspace ?? true;
    this._workspacePath = options.workspacePath ?? "/fake/workspace";
  }

  async isWorkspace(_path: string): Promise<boolean> {
    return this._isWorkspace;
  }

  isSessionWorkspace(_path: string): boolean {
    return false;
  }

  async getCurrentSession(_repoPath: string): Promise<string | undefined> {
    return undefined;
  }

  async getSessionFromWorkspace(_workspacePath: string): Promise<string | undefined> {
    return undefined;
  }

  async resolveWorkspacePath(_options: {
    workspace?: string;
    sessionRepo?: string;
  }): Promise<string> {
    return this._workspacePath;
  }
}
