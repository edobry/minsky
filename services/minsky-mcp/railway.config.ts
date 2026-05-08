import { defineRailwayConfig, secret } from "../../scripts/railway/lib";

export default defineRailwayConfig({
  projectId: "0e054318-7e19-4489-8e1e-de787965161d",
  environmentId: "0289b171-1514-4540-ac93-19b30da3e2c0",
  serviceId: "a7c5195f-55de-472a-87e4-34e921a15171",
  variables: {
    // -------------------------------------------------------------------
    // DATABASE URL VARIABLES (post-mt#1610)
    //
    // mt#1610 removed all `sessiondb:` config support. The generic
    // env-var-name -> dot-path parser turns `MINSKY_SESSIONDB_*` into a
    // `sessiondb.*` config block, which now trips a fail-closed
    // `LegacySessiondbConfigError` at boot. The MINSKY_SESSIONDB_* vars
    // MUST NOT be set on this service.
    //
    // Canonical env vars (see the `environmentMappings` constant in
    // src/domain/configuration/sources/environment.ts for the
    // authoritative table):
    // - MINSKY_PERSISTENCE_BACKEND       -> persistence.backend
    // - MINSKY_PERSISTENCE_POSTGRES_URL  -> persistence.postgres.connectionString
    //
    // MINSKY_POSTGRES_URL is also mapped to persistence.postgres.connectionString.
    // It is intentionally NOT set here: both vars target the same config path
    // and the loader applies them in declaration order without conflict
    // resolution, so setting both would let the second-declared silently win
    // if the values diverged. Single source of truth via
    // MINSKY_PERSISTENCE_POSTGRES_URL only.
    // -------------------------------------------------------------------
    MINSKY_APP_ID: "3436626",
    MINSKY_APP_INSTALLATION_ID: "125403046",
    MINSKY_GITHUB_APP_PRIVATE_KEY: secret("MINSKY_GITHUB_APP_PRIVATE_KEY"),
    MINSKY_MCP_AUTH_TOKEN: secret("MINSKY_MCP_AUTH_TOKEN"),
    MINSKY_MCP_MAX_SESSIONS: "1000",
    MINSKY_PERSISTENCE_BACKEND: "postgres",
    MINSKY_PERSISTENCE_POSTGRES_URL: secret("MINSKY_PERSISTENCE_POSTGRES_URL"),
    NODE_ENV: "production",
    OPENAI_API_KEY: secret("OPENAI_API_KEY"),
  },
});
