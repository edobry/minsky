#!/usr/bin/env bun

/**
 * Post-commit hook: update session activity state (best-effort)
 *
 * Fires after every `git commit` in a session workspace, making direct CLI commits
 * visible to liveness tracking (lastActivityAt, lastCommitHash, lastCommitMessage,
 * commitCount, status CREATED→ACTIVE).
 *
 * Must always exit 0 — errors are written to stderr but must never block commits.
 */

// tsyringe (used by PersistenceService) requires reflect-metadata polyfill
import "reflect-metadata";

import { execGitWithTimeout } from "../utils/git-exec";
import { getSessionsDir } from "../utils/paths";
import { SessionStatus } from "../domain/session/types";

/**
 * Detect whether CWD is inside a Minsky session workspace and extract the session ID.
 *
 * Uses git to find the repo root, then checks if that root lives under the sessions dir.
 * Returns null if not in a session (or if detection fails).
 */
async function detectSessionId(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execGitWithTimeout("rev-parse", "rev-parse --show-toplevel", {
      workdir: cwd,
      timeout: 5000,
    });
    const gitRoot = stdout.trim();
    const sessionsDir = getSessionsDir();

    if (!gitRoot.startsWith(sessionsDir)) {
      return null;
    }

    // Path structure: <sessionsDir>/<sessionId>/...
    const relativePath = gitRoot.substring(sessionsDir.length + 1);
    const sessionId = relativePath.split("/")[0];

    return sessionId || null;
  } catch {
    return null;
  }
}

/**
 * Read the latest commit hash and message from the current repo.
 */
async function getLatestCommitInfo(cwd: string): Promise<{ hash: string; message: string } | null> {
  try {
    const hashResult = await execGitWithTimeout("rev-parse", "rev-parse HEAD", {
      workdir: cwd,
      timeout: 5000,
    });
    const hash = hashResult.stdout.trim();

    const msgResult = await execGitWithTimeout("log", "log -1 --pretty=format:%s", {
      workdir: cwd,
      timeout: 5000,
    });
    const message = msgResult.stdout.trim();

    return { hash, message };
  } catch {
    return null;
  }
}

/**
 * Main post-commit hook logic.
 */
async function main(): Promise<void> {
  const cwd = process.cwd();

  // Step 1: Detect if we're in a session workspace
  const sessionId = await detectSessionId(cwd);
  if (!sessionId) {
    // Not in a session — nothing to do, exit silently
    return;
  }

  // Step 2: Get commit info
  const commitInfo = await getLatestCommitInfo(cwd);
  if (!commitInfo) {
    process.stderr.write(
      `[post-commit] Warning: could not read commit info for session ${sessionId}\n`
    );
    return;
  }

  // Step 3: Initialize session provider via the standard CLI composition pattern
  // Must initialize configuration first — PersistenceService depends on it
  const { setupConfiguration } = await import("../config-setup");
  const { PersistenceService } = await import("../domain/persistence/service");
  const persistenceService = new PersistenceService();
  let sessionProvider: import("../domain/session/types").SessionProviderInterface;
  try {
    await setupConfiguration();
    await persistenceService.initialize();
    const persistenceProvider = persistenceService.getProvider();

    const { createSessionProvider } = await import("../domain/session/session-db-adapter");
    sessionProvider = await createSessionProvider(undefined, persistenceProvider);
  } catch (err) {
    process.stderr.write(`[post-commit] Warning: could not initialize session provider: ${err}\n`);
    return;
  }

  // Step 4: Update session activity fields
  try {
    const currentSession = await sessionProvider.getSession(sessionId);
    if (!currentSession) {
      process.stderr.write(`[post-commit] Warning: session record not found for ID ${sessionId}\n`);
      return;
    }

    const newCommitCount = (currentSession.commitCount ?? 0) + 1;

    // Status only moves forward — CREATED→ACTIVE; never downgrade from PR_OPEN etc.
    const newStatus =
      currentSession.status === SessionStatus.CREATED
        ? SessionStatus.ACTIVE
        : currentSession.status;

    await sessionProvider.updateSession(sessionId, {
      lastActivityAt: new Date().toISOString(),
      lastCommitHash: commitInfo.hash,
      lastCommitMessage: commitInfo.message,
      commitCount: newCommitCount,
      status: newStatus,
    });
  } catch (err) {
    process.stderr.write(
      `[post-commit] Warning: failed to update session activity for ${sessionId}: ${err}\n`
    );
  } finally {
    // Step 5: Close persistence connection (best-effort)
    try {
      await persistenceService.close();
    } catch {
      // Ignore close errors
    }
  }
}

// Entry point — catch ALL errors and always exit 0
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[post-commit] Unexpected error: ${err}\n`);
  });
}
