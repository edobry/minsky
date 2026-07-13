import { z } from "zod";

/**
 * Railway configuration schema (mt#2124 / mt#2138).
 *
 * Holds the Railway API token used by Pulumi for IaC management (mt#2110).
 * Tokens are generated at https://railway.app/account/tokens.
 *
 * `strictObject` so typos inside the slot fail loud at load time.
 */
export const railwayConfigSchema = z
  .strictObject({
    /**
     * Railway API token for Pulumi IaC and Railway CLI operations.
     * Obtain from https://railway.app/account/tokens.
     */
    apiToken: z.string().optional(),
  })
  .optional();

export type RailwayConfig = z.infer<typeof railwayConfigSchema>;
