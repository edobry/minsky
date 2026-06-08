import { z } from "zod";
import { baseSchemas } from "./base";

/**
 * Reviewer webhook-service configuration (mt#2269).
 *
 * Backs the `reviewer.retrigger` command, which authenticates against the
 * minsky-reviewer webhook service's `POST /retrigger` endpoint. Both keys are
 * resolved through the standard config system, so they may be set in the user
 * or project config file OR overridden via the environment (the env source has
 * the highest merge priority):
 *
 *   - `reviewer.webhookSecret` ← `MINSKY_REVIEWER_WEBHOOK_SECRET`
 *   - `reviewer.url`           ← `MINSKY_REVIEWER_URL`
 *
 * Both env mappings are registered in
 * `sources/environment.ts` `environmentMappings` so a value set on a deployed
 * environment (Railway, CI) does not crash the dot-path config parser at boot.
 *
 * `strictObject` so typos inside the slot fail loud at load time.
 */
export const reviewerConfigSchema = z
  .strictObject({
    /**
     * Shared secret used to authenticate with the reviewer webhook service
     * (sent as the `Authorization: Bearer <secret>` header). Override via the
     * `MINSKY_REVIEWER_WEBHOOK_SECRET` env var.
     */
    webhookSecret: baseSchemas.optionalNonEmptyString,

    /**
     * Base URL of the reviewer webhook service. Override via the
     * `MINSKY_REVIEWER_URL` env var. When unset, `reviewer.retrigger` falls
     * back to the hosted default.
     */
    url: baseSchemas.url.optional(),
  })
  .optional();

export type ReviewerConfig = z.infer<typeof reviewerConfigSchema>;
