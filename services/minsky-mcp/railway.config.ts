import { defineRailwayConfig, secret } from "../../scripts/railway/lib";

export default defineRailwayConfig({
  projectId: "0e054318-7e19-4489-8e1e-de787965161d",
  environmentId: "0289b171-1514-4540-ac93-19b30da3e2c0",
  serviceId: "a7c5195f-55de-472a-87e4-34e921a15171",
  variables: {
    // -------------------------------------------------------------------
    // DATABASE URL VARIABLES — three vars, one value, operator responsibility
    //
    // These three vars all reference the same Postgres connection string.
    // Reference: memory/project_minsky_mcp_deployment.md
    //
    // - MINSKY_SESSIONDB_POSTGRES_URL  — canonical working contract (post-mt#1271).
    //   This is the var the deployed service actually reads. DO NOT REMOVE.
    //
    // - MINSKY_PERSISTENCE_POSTGRES_URL — new persistence-subsystem form. Kept for
    //   forward-compat as the persistence layer matures. The env mapping for
    //   persistence.postgres.connectionString is not yet fully wired; removing this
    //   would not change runtime behavior today, but we keep it to avoid config drift
    //   when the wiring lands.
    //
    // - MINSKY_POSTGRES_URL — legacy fallback var. Does not flip the backend on its own
    //   (that requires MINSKY_SESSIONDB_BACKEND=postgres). Kept for back-compat with any
    //   tooling or documentation that references the legacy name.
    //
    // OPERATOR RESPONSIBILITY: all three secret refs in ~/.config/minsky/railway-secrets.json
    // (MINSKY_SESSIONDB_POSTGRES_URL, MINSKY_PERSISTENCE_POSTGRES_URL, MINSKY_POSTGRES_URL)
    // MUST resolve to the same connection string. If they diverge, only
    // MINSKY_SESSIONDB_POSTGRES_URL matters at runtime, but drift will cause confusion.
    //
    // DO NOT run `--execute --prune` without confirming these vars are not in the removal
    // list — they would be pruned if accidentally omitted from this config.
    // -------------------------------------------------------------------
    MINSKY_APP_ID: "3436626",
    MINSKY_APP_INSTALLATION_ID: "125403046",
    MINSKY_GITHUB_APP_PRIVATE_KEY: secret("MINSKY_GITHUB_APP_PRIVATE_KEY"),
    MINSKY_MCP_AUTH_TOKEN: secret("MINSKY_MCP_AUTH_TOKEN"),
    MINSKY_MCP_MAX_SESSIONS: "1000",
    MINSKY_PERSISTENCE_BACKEND: "postgres",
    MINSKY_PERSISTENCE_POSTGRES_URL: secret("MINSKY_PERSISTENCE_POSTGRES_URL"),
    MINSKY_POSTGRES_URL: secret("MINSKY_POSTGRES_URL"),
    MINSKY_SESSIONDB_BACKEND: "postgres",
    MINSKY_SESSIONDB_POSTGRES_URL: secret("MINSKY_SESSIONDB_POSTGRES_URL"),
    NODE_ENV: "production",
    OPENAI_API_KEY: secret("OPENAI_API_KEY"),
  },
});
