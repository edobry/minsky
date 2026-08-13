import { z } from "zod";

/**
 * Transcript raw-archive configuration (ADR-025 / mt#2680).
 *
 * The archive is a PRIVATE Supabase Storage bucket holding each agent
 * session's raw transcript file as the immutable system of record.
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
