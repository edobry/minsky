import { z } from "zod";
import { baseSchemas } from "./base";

/**
 * Reviewer webhook-service configuration (mt#2269, amended mt#2346).
 *
 * Backs the `reviewer.retrigger` command's TARGET URL:
 *
 *   - `reviewer.url` ← `MINSKY_REVIEWER_URL`
 *
 * The env mapping is registered in `sources/environment.ts` `environmentMappings`
 * so a value set on a deployed environment (Railway, CI) does not crash the
 * dot-path config parser at boot.
 *
 * NOTE on `webhookSecret` (mt#2346): the retrigger command NO LONGER uses this
 * field — it now authenticates with the Minsky MCP auth token (`mcp.auth.token`
 * ← `MINSKY_MCP_AUTH_TOKEN`); the webhook HMAC secret is GitHub->reviewer
 * signature-verification only. The field + its env mapping are RETAINED so a
 * lingering `MINSKY_REVIEWER_WEBHOOK_SECRET` set in an operator/CI environment
 * still parses to a known config path instead of tripping the dot-path
 * auto-conversion and crashing the loader at boot (mt#1788 class). It can be
 * removed once that env var is confirmed unset everywhere.
 *
 * `strictObject` so typos inside the slot fail loud at load time.
 */
export const reviewerConfigSchema = z
  .strictObject({
    /**
     * @deprecated (mt#2346) No longer used for `reviewer.retrigger` auth — that
     * now uses `mcp.auth.token`. Retained only so a lingering
     * `MINSKY_REVIEWER_WEBHOOK_SECRET` env var still parses to a known path
     * (boot-safety, mt#1788 class). The reviewer SERVICE reads the webhook
     * secret from its own loader (`services/reviewer/src/config.ts`), not this
     * domain config path.
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
