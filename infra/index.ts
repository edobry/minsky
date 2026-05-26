import * as pulumi from "@pulumi/pulumi";
import * as railway from "@pulumi/railway";

const secrets = new pulumi.Config("secrets");

function defineVariables(
  serviceName: string,
  environmentId: string,
  serviceId: string,
  vars: Record<string, string | pulumi.Output<string>>
): Record<string, railway.Variable> {
  const resources: Record<string, railway.Variable> = {};
  for (const [name, value] of Object.entries(vars)) {
    resources[name] = new railway.Variable(`${serviceName}-var-${name}`, {
      environmentId,
      serviceId,
      name,
      value: typeof value === "string" ? value : value,
    });
  }
  return resources;
}

// ---------------------------------------------------------------------------
// minsky-mcp
// ---------------------------------------------------------------------------
const minskyMcpProject = "0e054318-7e19-4489-8e1e-de787965161d";
const minskyMcpEnv = "0289b171-1514-4540-ac93-19b30da3e2c0";
const minskyMcpServiceId = "a7c5195f-55de-472a-87e4-34e921a15171";

export const minskyMcpService = new railway.Service("minsky-mcp", {
  projectId: minskyMcpProject,
  name: "minsky-mcp",
  sourceImage: "ghcr.io/edobry/minsky:latest",
});

defineVariables("minsky-mcp", minskyMcpEnv, minskyMcpServiceId, {
  MINSKY_APP_ID: "3436626",
  MINSKY_APP_INSTALLATION_ID: "125403046",
  MINSKY_GITHUB_APP_PRIVATE_KEY: secrets.requireSecret("minsky-github-app-private-key"),
  MINSKY_MCP_AUTH_TOKEN: secrets.requireSecret("minsky-mcp-auth-token"),
  MINSKY_MCP_MAX_SESSIONS: "1000",
  MINSKY_PERSISTENCE_BACKEND: "postgres",
  MINSKY_PERSISTENCE_POSTGRES_URL: secrets.requireSecret("minsky-persistence-postgres-url"),
  NODE_ENV: "production",
  OPENAI_API_KEY: secrets.requireSecret("openai-api-key"),
  MINSKY_OAUTH_SIGNING_KEY: secrets.requireSecret("minsky-oauth-signing-key"),
});

// ---------------------------------------------------------------------------
// minsky-reviewer-webhook
// ---------------------------------------------------------------------------
const reviewerProject = "41e5ee9c-49e6-44ff-9bfe-7f03d0e94d4b";
const reviewerEnv = "b3ea3f5d-8560-40ea-8824-17fe3ca0b32a";
const reviewerServiceId = "3913e8a4-81ab-465a-aad8-b76b5e3f66ed";

export const reviewerService = new railway.Service("reviewer", {
  projectId: reviewerProject,
  name: "minsky-reviewer-webhook",
  sourceRepo: "edobry/minsky",
  sourceRepoBranch: "main",
  rootDirectory: "services/reviewer",
});

defineVariables("reviewer", reviewerEnv, reviewerServiceId, {
  MINSKY_REVIEWER_APP_ID: "3470137",
  MINSKY_REVIEWER_INSTALLATION_ID: "126244115",
  MINSKY_REVIEWER_PRIVATE_KEY: secrets.requireSecret("minsky-reviewer-private-key"),
  MINSKY_REVIEWER_WEBHOOK_SECRET: secrets.requireSecret("minsky-reviewer-webhook-secret"),
  MINSKY_REVIEWER_TIER2_ENABLED: "true",
  REVIEWER_PROVIDER: "openai",
  OPENAI_API_KEY: secrets.requireSecret("openai-api-key"),
  SWEEPER_ENABLED: "true",
  REVIEWER_COMPOSITION_CONVERGENCE_ENABLED: "true",
  MINSKY_MCP_URL: "https://minsky-mcp-production.up.railway.app/mcp",
  MINSKY_MCP_AUTH_TOKEN: secrets.requireSecret("minsky-mcp-auth-token"),
  MINSKY_SESSIONDB_POSTGRES_URL: secrets.requireSecret("minsky-sessiondb-postgres-url"),
});

// ---------------------------------------------------------------------------
// marketing site
// ---------------------------------------------------------------------------
const siteProject = "825920d3-fb22-4163-a50d-0e04fc724774";
const siteEnv = "bd90461e-dacf-487c-8594-b50849ade1f0";
const siteServiceId = "bb4d7cb4-e929-4ab6-83e2-d19cd34f6805";

export const siteService = new railway.Service("site", {
  projectId: siteProject,
  name: "minsky-site",
  sourceRepo: "edobry/minsky",
  sourceRepoBranch: "main",
  rootDirectory: "services/site",
});

defineVariables("site", siteEnv, siteServiceId, {
  NODE_ENV: "production",
  SITE_URL: "https://minsky.dev",
});

// ---------------------------------------------------------------------------
// cockpit preview (placeholder — Railway project not yet created, mt#2096)
// Uncomment and replace IDs after Railway project/service creation.
// ---------------------------------------------------------------------------
// const cockpitService = new railway.Service("cockpit", {
//   projectId: "REPLACE_AFTER_CREATION",
//   name: "cockpit-preview",
// });
// defineVariables("cockpit", "REPLACE", "REPLACE", {
//   MINSKY_PERSISTENCE_BACKEND: "postgres",
//   MINSKY_PERSISTENCE_POSTGRES_URL: secrets.requireSecret("minsky-cockpit-preview-postgres-url"),
//   MINSKY_COCKPIT_PREVIEW: "true",
// });

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
export const services = {
  minskyMcp: { projectId: minskyMcpProject, serviceId: minskyMcpServiceId },
  reviewer: { projectId: reviewerProject, serviceId: reviewerServiceId },
  site: { projectId: siteProject, serviceId: siteServiceId },
};
