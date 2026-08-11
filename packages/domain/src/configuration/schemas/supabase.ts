import { z } from "zod";

/**
 * Supabase configuration schema
 *
 * Holds Supabase credentials outside the Postgres connection string
 * (which lives under `persistence.postgres.connectionString`):
 *
 * - `accessToken` — developer-local Management API PAT (`sbp_*`), e.g. for
 *   `just supabase-usage`.
 * - `url` + `serviceRoleKey` — project URL and service-role secret for
 *   server-side Storage API access (transcript raw archive, ADR-025 /
 *   mt#2680). The service-role key bypasses RLS; it is a secret, masked by
 *   `src/utils/redaction.ts`, and must never appear in logs or public URLs.
 *
 * `strictObject` so typos inside the slot (e.g. `accesToken` vs
 * `accessToken`) fail loud at load time.
 */
export const supabaseConfigSchema = z
  .strictObject({
    /**
     * Supabase Personal Access Token used for Management API calls.
     * Obtain from https://supabase.com/dashboard/account/tokens.
     */
    accessToken: z.string().optional(),
    /** Project URL, e.g. https://<project-ref>.supabase.co */
    url: z.string().url().optional(),
    /**
     * Service-role API key (secret; trusted-server use only). Used by the
     * transcript archive store for private-bucket Storage access.
     */
    serviceRoleKey: z.string().optional(),
  })
  .optional();

export type SupabaseConfig = z.infer<typeof supabaseConfigSchema>;
