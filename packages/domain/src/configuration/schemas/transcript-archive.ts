import { z } from "zod";

/**
 * Transcript raw-archive configuration (mt#2680; ADR-025, re-scoped by ADR-045).
 *
 * The archive is a PRIVATE Supabase Storage bucket. Under ADR-045 it is a COLD
 * TIER that seals a session's raw transcript after close — not the system of
 * record, which is the insert-only Postgres `transcript_lines` table. The
 * settings below are unaffected by that re-scope.
 * Credentials live under `supabase.url` / `supabase.serviceRoleKey`; this
 * section holds only archive-specific settings.
 */
export const transcriptArchiveConfigSchema = z
  .strictObject({
    /** Private Storage bucket that holds the raw transcript archive. */
    bucket: z.string().min(1).default("agent-transcript-archive"),
  })
  .default({ bucket: "agent-transcript-archive" });

export type TranscriptArchiveConfig = z.infer<typeof transcriptArchiveConfigSchema>;
