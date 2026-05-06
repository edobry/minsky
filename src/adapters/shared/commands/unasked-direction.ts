/**
 * Unasked-direction CLI commands — Surface 4 weekly review tooling.
 *
 * Three commands under the `unasked-direction` namespace:
 *
 *   `unasked-direction.list`              — list pending findings (or all, with --all)
 *   `unasked-direction.mark-real`         — promote a finding to a Surface 2 signature seed
 *   `unasked-direction.mark-false-positive` — note dismissal verdict
 *
 * The CLI consumes the file store from
 * `src/domain/detectors/unasked-direction-store.ts` directly — no DB access
 * required, since v0.1 stores everything as per-session JSON.
 *
 * Reference: docs/research/mt1035-system3-detector.md §Surface 4
 * Reference: src/adapters/shared/commands/authorship.ts (sibling pattern)
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";
import type { SharedCommandRegistry } from "../command-registry";
import { log } from "../../../utils/logger";
import { getErrorMessage } from "../../../errors/index";
import {
  listFindingsSessions,
  readFindings,
  updateFindingVerdict,
  appendSignatureSeed,
  type FindingsRecord,
  type StoredFinding,
} from "../../../domain/detectors/unasked-direction-store";

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** A single row in the `list` output. */
export interface ListRow {
  sessionId: string;
  taskId?: string;
  findingIndex: number;
  label: string;
  severity: "low" | "medium" | "high";
  verdict: "pending" | "real" | "false-positive";
  analyzedAt: string;
  reviewedAt?: string;
}

/** Verdict-application result. */
export interface VerdictResult {
  applied: boolean;
  reason?: string;
  signatureSeeded?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Project a `FindingsRecord` into per-finding rows, optionally filtering to
 * pending verdicts only. Pure — no IO.
 */
export function projectFindingRows(record: FindingsRecord, pendingOnly: boolean): ListRow[] {
  const rows: ListRow[] = [];
  for (const stored of record.findings) {
    if (pendingOnly && stored.verdict !== "pending") continue;
    rows.push(buildRow(record, stored));
  }
  return rows;
}

function buildRow(record: FindingsRecord, stored: StoredFinding): ListRow {
  const row: ListRow = {
    sessionId: record.sessionId,
    findingIndex: stored.findingIndex,
    label: stored.finding.label,
    severity: stored.finding.severity,
    verdict: stored.verdict,
    analyzedAt: record.analyzedAt,
  };
  if (record.taskId !== undefined) row.taskId = record.taskId;
  if (stored.reviewedAt !== undefined) row.reviewedAt = stored.reviewedAt;
  return row;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the three `unasked-direction.*` commands.
 *
 * @param projectRoot Required: where to read/write findings + signature seed
 *                    files. CLI passes process.cwd(); tests pass tempdir.
 *                    Provided as a function so the registration call stays
 *                    side-effect-light and the path is read at execute time.
 * @param registry    Optional registry to register into (default: shared global).
 */
export function registerUnaskedDirectionCommands(
  projectRoot: () => string = () => process.cwd(),
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  // ── unasked-direction.list ────────────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "unasked-direction.list",
    category: CommandCategory.DETECTORS,
    name: "list",
    description:
      "List unasked-direction findings produced by the post-merge analyzer. " +
      "By default shows pending findings only; pass --all to include reviewed.",
    parameters: {
      all: {
        schema: z.boolean(),
        description: "Include findings already verdict-applied (default: false)",
        required: false,
        defaultValue: false,
      },
      sessionId: {
        schema: z.string(),
        description:
          "Restrict to a single session (default: walk all sessions in the findings directory)",
        required: false,
      },
    },
    async execute(params): Promise<{ rows: ListRow[] }> {
      const { all = false, sessionId } = params;
      const root = projectRoot();
      try {
        const sessions = sessionId ? [sessionId] : await listFindingsSessions(root);

        const rows: ListRow[] = [];
        for (const sid of sessions) {
          const record = await readFindings(root, sid);
          if (record === null) continue;
          rows.push(...projectFindingRows(record, !all));
        }

        rows.sort((a, b) => a.analyzedAt.localeCompare(b.analyzedAt));
        return { rows };
      } catch (error) {
        log.error("unasked-direction.list failed", { error: getErrorMessage(error) });
        throw error;
      }
    },
  });

  // ── unasked-direction.mark-real ───────────────────────────────────────────
  targetRegistry.registerCommand({
    id: "unasked-direction.mark-real",
    category: CommandCategory.DETECTORS,
    name: "mark-real",
    description:
      "Mark a finding as a real unasked direction — applies the verdict and " +
      "promotes the finding's suggested signature to the per-session seed file " +
      "for Surface 2 (mt#TBD) consumption.",
    parameters: {
      sessionId: {
        schema: z.string(),
        description: "Session whose finding is being verdicted",
        required: true,
      },
      findingIndex: {
        schema: z.number().int().nonnegative(),
        description: "0-based index of the finding within the session record",
        required: true,
      },
      note: {
        schema: z.string(),
        description: "Optional operator note attached to the verdict",
        required: false,
      },
    },
    async execute(params): Promise<VerdictResult> {
      const { sessionId, findingIndex, note } = params;
      const root = projectRoot();
      try {
        const record = await readFindings(root, sessionId);
        if (record === null) {
          return { applied: false, reason: "no findings record for session" };
        }
        const target = record.findings[findingIndex];
        if (target === undefined) {
          return { applied: false, reason: "finding index out of bounds" };
        }

        const applied = await updateFindingVerdict(root, sessionId, findingIndex, "real", note);
        if (!applied) {
          return { applied: false, reason: "failed to write verdict" };
        }

        const seed = await appendSignatureSeed(root, sessionId, {
          signature: target.finding.suggestedSignature,
          sourceSessionId: sessionId,
          sourceFindingIndex: findingIndex,
          promotedAt: new Date().toISOString(),
          ...(note !== undefined ? { note } : {}),
        });

        return { applied: true, signatureSeeded: seed };
      } catch (error) {
        log.error("unasked-direction.mark-real failed", { error: getErrorMessage(error) });
        throw error;
      }
    },
  });

  // ── unasked-direction.mark-false-positive ─────────────────────────────────
  targetRegistry.registerCommand({
    id: "unasked-direction.mark-false-positive",
    category: CommandCategory.DETECTORS,
    name: "mark-false-positive",
    description:
      "Mark a finding as a false positive — applies the verdict; does NOT " +
      "produce a signature seed.",
    parameters: {
      sessionId: {
        schema: z.string(),
        description: "Session whose finding is being verdicted",
        required: true,
      },
      findingIndex: {
        schema: z.number().int().nonnegative(),
        description: "0-based index of the finding within the session record",
        required: true,
      },
      note: {
        schema: z.string(),
        description: "Optional operator note attached to the verdict",
        required: false,
      },
    },
    async execute(params): Promise<VerdictResult> {
      const { sessionId, findingIndex, note } = params;
      const root = projectRoot();
      try {
        const applied = await updateFindingVerdict(
          root,
          sessionId,
          findingIndex,
          "false-positive",
          note
        );
        if (!applied) {
          return { applied: false, reason: "failed to write verdict" };
        }
        return { applied: true };
      } catch (error) {
        log.error("unasked-direction.mark-false-positive failed", {
          error: getErrorMessage(error),
        });
        throw error;
      }
    },
  });

  log.debug("Unasked-direction commands registered");
}
