import { z } from "zod";

/**
 * Supabase configuration schema
 *
 * Holds developer-local credentials for Supabase Management API operations
 * (e.g. `just supabase-usage`). The token is a Supabase Personal Access
 * Token (`sbp_*` prefix), not a database connection credential —
 * connection strings live under `persistence.postgres.connectionString`.
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
  })
  .optional();

export type SupabaseConfig = z.infer<typeof supabaseConfigSchema>;
