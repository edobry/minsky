/**
 * Session-family `task` convenience-resolution-param parity check (mt#2816).
 *
 * mt#2816 closed a param-alias drift: `session_commit` declared the family's
 * canonical `sessionId` param but silently rejected `task`, even though
 * `session_start`/`session_exec` both accept `task` as a convenience alias
 * that resolves to the session bound to that task. The mt#2780 ESLint rule
 * (`custom/no-entity-id-param-drift`) does NOT catch this class: its
 * `FAMILY_CONVENTIONS` table for the `session` family only checks
 * `sessionId` (canonical) vs. `session` (alias) — the SAME entity under two
 * names. It has no notion of "sessionId present implies task should be
 * present too" (a cross-entity convenience-resolution invariant, not a
 * same-entity naming-drift invariant), so it would not have caught the
 * mt#2816 bug and will not catch a future recurrence.
 *
 * This test is the "sibling check" mt#2816's spec calls for: it builds every
 * LIVE session command (the exact factory list `session.ts`'s
 * `registerSessionCommands` registers — not a glob/AST scan, so dead code
 * like the top-level `session-parameters.ts`'s unused exports can't produce
 * false positives) and asserts the family invariant directly against each
 * command's real, resolved `parameters:` map:
 *
 *   sessionId present => task present (unless explicitly exempted below,
 *   with a documented reason).
 *
 * Add a new session command to the `COMMANDS` array below whenever one is
 * added to `session.ts`'s registration array — otherwise this test silently
 * stops covering it.
 */

import { describe, test, expect } from "bun:test";
import type { AnyCommandDefinition } from "../../command-registry";
import type { LazySessionDeps } from "./types";

import {
  createSessionListCommand,
  createSessionGetCommand,
  createSessionStartCommand,
  createSessionDirCommand,
  createSessionSearchCommand,
  createSessionExecCommand,
} from "./basic-commands";
import {
  createSessionDeleteCommand,
  createSessionUpdateCommand,
  createSessionMigrateBackendCommand,
  createSessionMigrateCommand,
} from "./management-commands";
import { createSessionCleanupCommand } from "./cleanup-command";
import { createSessionPsCommand, createSessionAttachedCommand } from "./ps-command";
import {
  createSessionCommitCommand,
  createSessionInspectCommand,
  createSessionReviewCommand,
  createSessionPrApproveCommand,
  createSessionPrMergeCommand,
  createSessionPrCreateCommand,
  createSessionPrEditCommand,
  createSessionPrCloseCommand,
  createSessionPrListCommand,
  createSessionPrGetCommand,
  createSessionPrOpenCommand,
  createSessionPrChecksCommand,
  createSessionPrWaitForReviewCommand,
  createSessionPrDriveCommand,
  createSessionPrReviewContextCommand,
  createSessionPrReviewSubmitCommand,
  createSessionPrReviewDismissCommand,
  createSessionPrReviewThreadResolveCommand,
  createSessionPrCheckRunSubmitCommand,
} from "./workflow-commands";
import { createSessionConflictsCommand } from "./conflicts-command";
import { createSessionRepairCommand } from "./repair-command";
import { createSessionEditFileCommand } from "./file-commands";
import { createSessionGeneratePromptCommand } from "./prompt-command";
import { createApplyPostMergeStateSyncCommand } from "./apply-post-merge-state-sync-command";

// Never invoked — command factories only call this lazily, inside execute().
const dummyGetDeps: LazySessionDeps = () =>
  Promise.reject(new Error("dummyGetDeps should never be invoked by this parity test"));
const dummyGetPersistenceProvider = () => undefined;

/**
 * Every command `session.ts`'s `registerSessionCommands` registers. Kept as
 * a literal factory call list (not a registry/DI-driven enumeration) so this
 * test has zero dependency on persistence/container wiring.
 */
const COMMANDS: AnyCommandDefinition[] = [
  createSessionListCommand(dummyGetDeps, dummyGetPersistenceProvider),
  createSessionGetCommand(dummyGetDeps, dummyGetPersistenceProvider),
  createSessionStartCommand(dummyGetDeps, dummyGetPersistenceProvider),
  createSessionDirCommand(dummyGetDeps),
  createSessionSearchCommand(dummyGetDeps),
  createSessionExecCommand(dummyGetDeps),
  createSessionPsCommand(dummyGetDeps, dummyGetPersistenceProvider),
  createSessionAttachedCommand(dummyGetDeps, dummyGetPersistenceProvider),

  createSessionDeleteCommand(dummyGetDeps),
  createSessionUpdateCommand(dummyGetDeps),
  createSessionMigrateBackendCommand(dummyGetDeps),
  createSessionCleanupCommand(dummyGetDeps),

  createSessionCommitCommand(dummyGetDeps),
  createSessionInspectCommand(dummyGetDeps),
  createSessionReviewCommand(dummyGetDeps),

  createSessionPrCreateCommand(dummyGetDeps),
  createSessionPrEditCommand(dummyGetDeps),
  createSessionPrListCommand(dummyGetDeps),
  createSessionPrGetCommand(dummyGetDeps),
  createSessionPrOpenCommand(dummyGetDeps),
  createSessionPrApproveCommand(dummyGetDeps),
  createSessionPrCloseCommand(dummyGetDeps),
  createSessionPrMergeCommand(dummyGetDeps),
  createSessionPrChecksCommand(dummyGetDeps),
  createSessionPrWaitForReviewCommand(dummyGetDeps),
  createSessionPrDriveCommand(dummyGetDeps),
  createSessionPrReviewContextCommand(dummyGetDeps),
  createSessionPrReviewSubmitCommand(dummyGetDeps),
  createSessionPrReviewDismissCommand(dummyGetDeps),
  createSessionPrReviewThreadResolveCommand(dummyGetDeps),
  createSessionPrCheckRunSubmitCommand(dummyGetDeps),

  createSessionMigrateCommand(dummyGetDeps),

  createSessionConflictsCommand(dummyGetDeps),
  createSessionRepairCommand(dummyGetDeps),
  createSessionGeneratePromptCommand(dummyGetDeps),

  createApplyPostMergeStateSyncCommand(dummyGetDeps),

  createSessionEditFileCommand(dummyGetDeps),
];

/**
 * Commands intentionally exempted from the "sessionId present => task
 * present" invariant, with the reason each is legitimate (not drift).
 * Empty today — every session command that accepts `sessionId` also accepts
 * `task` as of mt#2816. Add an entry here ONLY with a recorded reason; do
 * not add an entry just to silence a genuine new instance of the drift.
 */
const EXEMPTIONS: Record<string, string> = {};

describe("session_* family: sessionId => task parity (mt#2816 sibling check)", () => {
  test("every registered session command's parameters map is non-empty (sanity)", () => {
    // Guards against the COMMANDS list itself silently going stale (e.g. a
    // factory throwing during construction and being swallowed elsewhere).
    expect(COMMANDS.length).toBeGreaterThan(20);
    for (const cmd of COMMANDS) {
      expect(cmd.parameters).toBeDefined();
    }
  });

  test("every command declaring `sessionId` also declares `task`, unless exempted", () => {
    const violations: string[] = [];

    for (const cmd of COMMANDS) {
      const params = cmd.parameters as Record<string, unknown> | undefined;
      if (!params || !("sessionId" in params)) continue; // not applicable
      if ("task" in params) continue; // compliant
      if (cmd.id in EXEMPTIONS) continue; // documented exemption

      violations.push(cmd.id);
    }

    if (violations.length > 0) {
      throw new Error(
        `Session command(s) declare 'sessionId' without the family's 'task' convenience-` +
          `resolution alias (mt#2816 drift class): ${violations.join(", ")}. Either add ` +
          `'task' to the command's params map + resolve it via resolveSessionIdForCommand ` +
          `(session-context-resolver.ts), or add a documented EXEMPTIONS entry above.`
      );
    }

    expect(violations).toEqual([]);
  });

  test("regression: session.commit and session.edit-file specifically carry `task` (the originating mt#2816 bug)", () => {
    const commit = COMMANDS.find((c) => c.id === "session.commit");
    const editFile = COMMANDS.find((c) => c.id === "session.edit-file");
    expect(commit?.parameters && "task" in commit.parameters).toBe(true);
    expect(editFile?.parameters && "task" in editFile.parameters).toBe(true);
  });
});
