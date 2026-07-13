/**
 * Attention Window config types — mt#1489.
 *
 * Defines the schema for `~/.config/minsky/attention.yaml` and the resolved
 * typed config object returned by the loader. Each named window declares when
 * it opens (cron schedule or "manual"), how long it lasts, and how many misses
 * before the Ask escalates.
 *
 * Design rationale: v0 is purely file-based (no DB table). The router-extension
 * child (mt#1490) reads these configs by `windowKey` at dispatch time. The
 * Cockpit (mt#1147) subscribes to Postgres NOTIFY events emitted on open/close.
 *
 * Reference: ADR draft Notion `352937f03cb481669ab9c57be181d5b8`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas (validate the raw YAML shape)
// ---------------------------------------------------------------------------

/**
 * Raw YAML shape for a single window entry.
 *
 * `schedule` is either a 5-field cron expression ("0 16 * * MON-FRI") or the
 * literal string "manual". "manual" windows never open automatically — only
 * via `minsky window open <key>`.
 */
export const rawWindowEntrySchema = z.object({
  schedule: z.string().min(1, "schedule is required"),
  durationMin: z
    .number()
    .int()
    .positive("durationMin must be a positive integer")
    .describe("How long the window stays open, in minutes"),
  maxMisses: z
    .number()
    .int()
    .min(-1, "maxMisses must be >= -1 (-1 means infinite)")
    .describe(
      "How many scheduled windows an Ask may miss before escalation. -1 means never escalate."
    ),
  description: z.string().optional().describe("Human-readable label shown in `window list`"),
});

export type RawWindowEntry = z.infer<typeof rawWindowEntrySchema>;

/**
 * Raw YAML file schema — top-level `windows:` map.
 */
export const rawAttentionConfigSchema = z.object({
  windows: z.record(z.string(), rawWindowEntrySchema),
});

export type RawAttentionConfig = z.infer<typeof rawAttentionConfigSchema>;

// ---------------------------------------------------------------------------
// Resolved typed config
// ---------------------------------------------------------------------------

/**
 * Resolved config for a single attention window.
 *
 * After parsing the YAML, the loader promotes the map key to `key` and normalises
 * `schedule` into a discriminated union so callers never need to string-compare.
 */
export interface AttentionWindowConfig {
  /** The map key from the YAML (e.g. "ask-hours", "weekly-review"). */
  key: string;
  /**
   * Resolved schedule.
   * - `{ type: "cron"; expr: string }` — cron expression as written in YAML.
   * - `{ type: "manual" }` — never fires automatically.
   */
  schedule: { type: "cron"; expr: string } | { type: "manual" };
  /** How long the window stays open, in minutes. */
  durationMin: number;
  /**
   * How many scheduled windows an Ask may miss before the router escalates it.
   * -1 means never escalate (infinite patience).
   */
  maxMisses: number;
  /** Optional human-readable description. */
  description?: string;
}

// ---------------------------------------------------------------------------
// Default config (first-run)
// ---------------------------------------------------------------------------

/**
 * Default attention windows applied when no config file is present.
 *
 * Keeps v0 dogfoodable out-of-the-box: daily 4pm ask-hours window (Monday–Friday)
 * and a weekly Monday review window.
 */
export const DEFAULT_ATTENTION_WINDOWS: AttentionWindowConfig[] = [
  {
    key: "ask-hours",
    schedule: { type: "cron", expr: "0 16 * * 1-5" },
    durationMin: 30,
    maxMisses: 2,
    description: "Daily 4pm decision window (weekdays)",
  },
  {
    key: "weekly-review",
    schedule: { type: "cron", expr: "0 10 * * 1" },
    durationMin: 60,
    maxMisses: 1,
    description: "Weekly Monday morning review",
  },
];
