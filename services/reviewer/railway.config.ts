import { defineRailwayConfig, secret } from "../../scripts/railway/lib";

export default defineRailwayConfig({
  projectId: "41e5ee9c-49e6-44ff-9bfe-7f03d0e94d4b",
  environmentId: "b3ea3f5d-8560-40ea-8824-17fe3ca0b32a",
  serviceId: "3913e8a4-81ab-465a-aad8-b76b5e3f66ed",
  variables: {
    // -------------------------------------------------------------------
    // GitHub App identity (minsky-reviewer)
    // -------------------------------------------------------------------
    MINSKY_REVIEWER_APP_ID: "3470137",
    MINSKY_REVIEWER_INSTALLATION_ID: "126244115",
    MINSKY_REVIEWER_PRIVATE_KEY: secret("MINSKY_REVIEWER_PRIVATE_KEY"),
    MINSKY_REVIEWER_WEBHOOK_SECRET: secret("MINSKY_REVIEWER_WEBHOOK_SECRET"),

    // -------------------------------------------------------------------
    // Reviewer behavior flags
    // -------------------------------------------------------------------
    // Tier-2 reviewer-bot enablement (mt#1083). "true" = bot auto-fires on
    // PR open / push events.
    MINSKY_REVIEWER_TIER2_ENABLED: "true",

    // Provider routing for the reviewer model. Other providers
    // (anthropic, google) require their corresponding *_API_KEY var.
    REVIEWER_PROVIDER: "openai",
    OPENAI_API_KEY: secret("OPENAI_API_KEY"),

    // mt#1260 missed-review sweeper toggle. Distinct from the mt#1614
    // merge-state sweeper (controlled by MERGE_STATE_SWEEPER_ENABLED,
    // which defaults to "true" post-mt#1811 and is left unset here so
    // the in-code default applies).
    SWEEPER_ENABLED: "true",

    // -------------------------------------------------------------------
    // mt#1614 recovery-layer wiring (mt#1811)
    //
    // The reviewer service hosts the post-merge state-sync recovery layer
    // (webhook handler + 10-min sweeper backstop). Both paths invoke
    // apply_post_merge_state_sync on the Minsky MCP server.
    //
    // MINSKY_MCP_TOKEN is the bearer token the reviewer presents to the
    // hosted MCP server. The deployed-env-var name is MINSKY_MCP_TOKEN
    // (client side); the server-side counterpart is MINSKY_MCP_AUTH_TOKEN.
    // Per mt#1811 outcome, both vars carry the same value, so we resolve
    // from the shared MINSKY_MCP_AUTH_TOKEN entry in railway-secrets.json
    // rather than maintaining a duplicate key.
    // -------------------------------------------------------------------
    MINSKY_MCP_URL: "https://minsky-mcp-production.up.railway.app/mcp",
    MINSKY_MCP_TOKEN: secret("MINSKY_MCP_AUTH_TOKEN"),

    // -------------------------------------------------------------------
    // Postgres connection for the reviewer service's convergence-metrics
    // schema. Per services/reviewer/DEPLOY.md the service reads
    // MINSKY_SESSIONDB_POSTGRES_URL directly via src/db/client.ts and
    // applies drizzle migrations from services/reviewer/migrations/pg
    // before opening the webhook listener.
    //
    // NOTE: this var is named MINSKY_SESSIONDB_POSTGRES_URL on the
    // reviewer service for historical reasons. It is NOT a Minsky-core
    // config consumer (the reviewer service does not load the central
    // Minsky configuration loader), so the mt#1610 fail-closed check on
    // MINSKY_SESSIONDB_* in src/domain/configuration/sources/environment.ts
    // does NOT apply here. Do NOT set this var on services/minsky-mcp —
    // it will crash that service's boot.
    // -------------------------------------------------------------------
    MINSKY_SESSIONDB_POSTGRES_URL: secret("MINSKY_SESSIONDB_POSTGRES_URL"),
  },
});
