/**
 * Transcript List Command
 *
 * Registers the `transcripts.list` MCP tool and `minsky transcripts list`
 * CLI command (mt#2818).
 *
 * Answers "what are the last N conversations?" in-band — a gap that forced
 * the 2026-07-15 gap-analysis session (and 11 analysis subagents) onto disk
 * `jq` extraction, the exact DB-substrate bypass the substrate-bypass
 * detector polices. Zero disk access by default: every field below is
 * sourced from `agent_transcripts` / `agent_transcript_turns` /
 * `minsky_session_links` / `agent_spawns` / `subagent_invocations`.
 *
 * ## Coverage honesty (mt#2818 SC#3)
 *
 * A conversation whose disk JSONL exists but has never been ingested has NO
 * row in `agent_transcripts` at all, so it cannot appear in this list by
 * construction — the search-tool `coverage` pattern (mt#2319 SC#4) reports a
 * WINDOW gap over rows that exist; this tool's gap is about rows that don't
 * exist yet. Detecting that requires walking the on-disk JSONL tree (the
 * same discovery `ClaudeCodeTranscriptSource.discoverSessions()` performs for
 * the ingest sweep), which is NOT bounded-and-cheap on the hot list path —
 * it stats every project dir and, for cwd recovery, reads the head of every
 * JSONL file (hundreds of files at current scale). Running that unconditionally
 * would also violate the "zero disk access" contract this tool's own
 * acceptance test (mt#2818 AT#4) verifies. So:
 *
 *   - By DEFAULT, no disk access occurs. Each row carries its own
 *     `lastIngestedJsonlTimestamp` (mt#2818 SC#3's documented fallback) —
 *     staleness of an ALREADY-INGESTED conversation is visible per-row.
 *   - Pass `checkDiskCoverage: true` to opt into the disk-discovery sweep
 *     (reusing `ClaudeCodeTranscriptSource`, the exact mechanism
 *     `transcripts.ingest --all` uses) and get a genuine "conversations on
 *     disk with zero DB rows" count + sample.
 *
 * @see mt#2818 — this file
 * @see mt#2770 — conversation labeling precedence (label composed here from
 *   `TranscriptListService`'s raw inputs via the pure functions in
 *   `packages/domain/src/transcripts/conversation-label.ts`, lifted there
 *   from `src/cockpit/conversation-label.ts` by mt#2818)
 * @see mt#2817 — loud list-truncation convention
 * @see mt#2580 — blob-drop direction: this command reads `agent_transcripts`
 *   scalar columns + `agent_transcript_turns`, never `agent_transcripts.transcript`
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import type { SharedCommandRegistry } from "../../command-registry";
import { log } from "@minsky/shared/logger";
import { getErrorMessage } from "@minsky/domain/errors/index";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { ListTruncationMetadata } from "@minsky/domain/utils/list-pagination";
import type { TranscriptListRow } from "@minsky/domain/transcripts/transcript-list-service";
// mt#2818 reuses the mt#2770 pure label-precedence functions directly rather
// than re-deriving the same decision in a second place (both call sites must
// agree on precedence, and duplicating the logic is how the two drift).
// Imported from the domain layer (not `src/cockpit/`) — the module was
// lifted there specifically so the command layer never depends on the
// cockpit app layer.
import {
  computeConversationLabel,
  composeSubagentDescriptor,
  deriveFallbackLabel,
  pickSubstantiveUserText,
} from "@minsky/domain/transcripts/conversation-label";

// ── Output shape ─────────────────────────────────────────────────────────────

export interface TranscriptListEntry {
  conversationId: string;
  harness: string;
  startedAt: string | null;
  endedAt: string | null;
  firstTurnAt: string | null;
  lastTurnAt: string | null;
  turnCount: number;
  /** mt#2770 content-derived label (task title / first-prompt snippet / subagent descriptor / fallback). */
  label: string;
  /** LLM-generated session summary, when the summary pipeline has run for this conversation. */
  summary: string | null;
  relatedTaskIds: string[];
  relatedPrNumbers: string[];
  /** Bound Minsky task id (display form), when `minsky_session_links` resolved one. */
  linkedTaskId: string | null;
  /** Ingest high-water-mark — see the module docblock's coverage-honesty section. */
  lastIngestedJsonlTimestamp: string | null;
}

export interface TranscriptListDiskCoverage {
  count: number;
  sampleConversationIds: string[];
}

export interface TranscriptListCoverage {
  /** Whether the (opt-in, disk-touching) discovery sweep ran — see module docblock. */
  diskCoverageChecked: boolean;
  /** Present only when `diskCoverageChecked` and disk sessions were found with zero DB rows. */
  unIngestedOnDisk?: TranscriptListDiskCoverage;
  note: string;
}

/**
 * mt#2818 R1: extends `ListTruncationMetadata` directly (`{returned, total,
 * truncated}`) rather than spreading it into a loosely-typed return via an
 * `as`-cast — matches how `tasks.list` declares its mt#2817 shape in
 * `src/adapters/shared/commands/tasks/crud-commands.ts`.
 */
export interface TranscriptListResponse extends ListTruncationMetadata {
  conversations: TranscriptListEntry[];
  coverage: TranscriptListCoverage;
}

const DEFAULT_NOTE =
  "No on-disk discovery sweep was performed (zero disk access — see checkDiskCoverage). " +
  "Per-conversation lastIngestedJsonlTimestamp shows ingest freshness for already-known conversations.";

const DISK_SAMPLE_LIMIT = 10;

// ── Registration ──────────────────────────────────────────────────────────────

export function registerTranscriptListCommand(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  targetRegistry.registerCommand({
    id: "transcripts.list",
    category: CommandCategory.TRANSCRIPTS,
    name: "list",
    description:
      "List recent harness conversations, most-recent-first, with summary metadata: " +
      "turn count, first/last turn timestamps, an mt#2770 content-derived label, " +
      "LLM summary (when generated), and workspace/task linkage where known. " +
      "Zero disk access by default (see checkDiskCoverage for the opt-in disk-discovery sweep). " +
      "Loud-cap truncation metadata (mt#2817): { returned, total, truncated }. " +
      "Coverage: reports whether a disk-discovery sweep ran, and surfaces lastIngestedJsonlTimestamp " +
      "per conversation so staleness is never silently invisible.",
    parameters: {
      limit: {
        schema: z.number().int().positive(),
        description: "Maximum number of conversations to return (default: 500)",
        required: false,
      },
      checkDiskCoverage: {
        schema: z.boolean(),
        description:
          "Opt into a live on-disk discovery sweep (reuses the same discovery the ingest sweep " +
          "uses) to detect conversations that exist on disk but have never been ingested. " +
          "Off by default — this touches disk (stats every project dir, reads JSONL heads for " +
          "cwd recovery) and is NOT part of the tool's zero-disk-access default contract.",
        required: false,
        defaultValue: false,
      },
    },

    async execute(params, context): Promise<TranscriptListResponse> {
      const limit = params.limit as number | undefined;
      const checkDiskCoverage = (params.checkDiskCoverage as boolean | undefined) ?? false;

      // ── Resolve DB from DI container ─────────────────────────────────────
      const persistenceProvider = (() => {
        if (context.container?.has("persistence")) {
          return context.container.get(
            "persistence"
          ) as import("@minsky/domain/persistence/types").SqlCapablePersistenceProvider;
        }
        return null;
      })();

      if (!persistenceProvider) {
        throw new Error(
          "DI container missing 'persistence'. " +
            "Ensure the container was initialized before running this command."
        );
      }

      const db = await persistenceProvider.getDatabaseConnection();
      if (!db) {
        throw new Error(
          "getDatabaseConnection() returned null. " +
            "transcripts.list requires a PostgreSQL backend with Drizzle ORM."
        );
      }

      // ── Fetch base list + enrichment (zero disk access) ──────────────────
      const { TranscriptListService } = await import(
        "@minsky/domain/transcripts/transcript-list-service"
      );
      const svc = new TranscriptListService(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase
      );
      const { conversations: rows, truncation } = await svc.listConversations({ limit });

      // ── Resolve task titles for tier-1/tier-3 label inputs (best-effort) ──
      const { titles: taskTitles, degradedNoTaskService } = await resolveTaskTitles(rows, context);

      const conversations: TranscriptListEntry[] = rows.map((row) => buildEntry(row, taskTitles));

      // ── Coverage ──────────────────────────────────────────────────────────
      const coverage = checkDiskCoverage
        ? await buildDiskCoverage(rows.map((r) => r.agentSessionId))
        : { diskCoverageChecked: false, note: DEFAULT_NOTE };

      // mt#2818 R1 nit: surface the taskService-absent degradation explicitly
      // rather than letting it silently lower some rows' labels to a later
      // tier with no signal in the payload.
      if (degradedNoTaskService) {
        coverage.note +=
          " No taskService was bound in the DI container — task-title-derived " +
          "label tiers (bound-task and subagent-dispatch titles) were skipped " +
          "for rows that had a resolvable task id; those rows fell through to " +
          "a lower-precedence label tier instead.";
      }

      log.debug("transcripts.list complete", {
        returned: truncation.returned,
        total: truncation.total,
        truncated: truncation.truncated,
        diskCoverageChecked: coverage.diskCoverageChecked,
        degradedNoTaskService,
      });

      return { conversations, coverage, ...truncation };
    },
  });

  log.debug("Transcript list command registered");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildEntry(row: TranscriptListRow, taskTitles: Map<string, string>): TranscriptListEntry {
  const linkedTaskTitle = row.linkedTaskId ? (taskTitles.get(row.linkedTaskId) ?? null) : null;
  const firstUserText = pickSubstantiveUserText(row.firstUserTurnCandidates);
  const subagentDescriptor = composeSubagentDescriptor({
    invocationAgentType: row.subagentInvocationAgentType,
    invocationTaskId: row.subagentInvocationTaskId,
    invocationTaskTitle: row.subagentInvocationTaskId
      ? (taskTitles.get(row.subagentInvocationTaskId) ?? null)
      : null,
    spawnAgentKind: row.subagentSpawnAgentKind,
  });

  const label =
    linkedTaskTitle || firstUserText || subagentDescriptor
      ? computeConversationLabel({
          agentSessionId: row.agentSessionId,
          cwd: row.cwd,
          startedAt: row.startedAt,
          linkedTaskTitle,
          firstUserText,
          subagentDescriptor,
        })
      : deriveFallbackLabel(row.agentSessionId, row.cwd, row.startedAt);

  return {
    conversationId: row.agentSessionId,
    harness: row.harness,
    startedAt: toIso(row.startedAt),
    endedAt: toIso(row.endedAt),
    firstTurnAt: toIso(row.firstTurnAt),
    lastTurnAt: toIso(row.lastTurnAt),
    turnCount: row.turnCount,
    label,
    summary: row.summary,
    relatedTaskIds: row.relatedTaskIds ?? [],
    relatedPrNumbers: row.relatedPrNumbers ?? [],
    linkedTaskId: row.linkedTaskId,
    lastIngestedJsonlTimestamp: toIso(row.lastIngestedJsonlTimestamp),
  };
}

function toIso(d: Date | null): string | null {
  return d instanceof Date ? d.toISOString() : null;
}

/** Result of {@link resolveTaskTitles} — see its docblock for `degraded`'s meaning. */
interface TaskTitleResolution {
  titles: Map<string, string>;
  /**
   * True when candidate ids existed (tier-1 `linkedTaskId` and/or tier-3
   * `subagentInvocationTaskId` resolved on at least one row) but titles could
   * NOT be resolved because no `taskService` was bound in the DI container.
   * mt#2818 R1 nit: surfaced explicitly in the response's `coverage.note`
   * (see `execute()`) rather than silently degrading labels to a lower tier
   * with no signal — a caller comparing this list against a UI that DOES
   * have task titles could otherwise misread the gap as a data problem.
   */
  degradedNoTaskService: boolean;
}

/**
 * Batch-resolve display-form task ids (tier-1 linkedTaskId, tier-3
 * subagentInvocationTaskId) to titles via the DI container's taskService,
 * when one is bound. Never throws — an unresolved title just means those
 * label tiers fall through to the next tier (mirrors mt#2770's
 * `NULL_TASK_PROVIDER` degrade-gracefully behavior in the cockpit widget) —
 * but the fact that this happened is reported via `degradedNoTaskService`
 * rather than only being silently absorbed.
 */
async function resolveTaskTitles(
  rows: TranscriptListRow[],
  context: { container?: AppContainerInterface }
): Promise<TaskTitleResolution> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.linkedTaskId) ids.add(row.linkedTaskId);
    if (row.subagentInvocationTaskId) ids.add(row.subagentInvocationTaskId);
  }
  if (ids.size === 0) return { titles: new Map(), degradedNoTaskService: false };

  if (!context.container?.has("taskService")) {
    return { titles: new Map(), degradedNoTaskService: true };
  }

  try {
    const taskService = context.container.get(
      "taskService"
    ) as import("@minsky/domain/tasks/taskService").TaskServiceInterface;
    const tasks = await taskService.getTasks(Array.from(ids));
    return { titles: new Map(tasks.map((t) => [t.id, t.title])), degradedNoTaskService: false };
  } catch (err) {
    log.warn(`transcripts.list: task title resolution failed: ${getErrorMessage(err)}`);
    return { titles: new Map(), degradedNoTaskService: false };
  }
}

/**
 * Opt-in disk-discovery coverage sweep (mt#2818 SC#3) — reuses
 * `ClaudeCodeTranscriptSource.discoverSessions()`, the same mechanism
 * `transcripts.ingest --all` uses, to find conversations on disk with zero
 * rows in `agent_transcripts`.
 */
async function buildDiskCoverage(knownIds: string[]): Promise<TranscriptListCoverage> {
  try {
    const { ClaudeCodeTranscriptSource } = await import(
      "@minsky/domain/transcripts/claude-code-transcript-source"
    );
    const source = new ClaudeCodeTranscriptSource();
    const known = new Set(knownIds);
    const missing: string[] = [];
    let scanned = 0;

    for await (const session of source.discoverSessions()) {
      scanned++;
      if (!known.has(session.agentSessionId)) {
        missing.push(session.agentSessionId);
      }
    }

    if (missing.length === 0) {
      return {
        diskCoverageChecked: true,
        note: `Disk-discovery sweep found ${scanned} on-disk session(s); all are present in agent_transcripts.`,
      };
    }

    return {
      diskCoverageChecked: true,
      unIngestedOnDisk: {
        count: missing.length,
        sampleConversationIds: missing.slice(0, DISK_SAMPLE_LIMIT),
      },
      note:
        `${missing.length} on-disk session(s) have zero rows in agent_transcripts. ` +
        "Run `transcripts ingest --all` to backfill them.",
    };
  } catch (err) {
    // Coverage is informational — never fail the whole list on a disk-scan error.
    log.warn(`transcripts.list: disk-coverage sweep failed: ${getErrorMessage(err)}`);
    return {
      diskCoverageChecked: false,
      note: `Disk-discovery sweep failed and was skipped: ${getErrorMessage(err)}`,
    };
  }
}
