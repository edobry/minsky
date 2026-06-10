import * as pulumi from "@pulumi/pulumi";
import * as railway from "@pulumi/railway";

const secrets = new pulumi.Config("secrets");

interface VarDef {
  value: string | pulumi.Output<string>;
  sealed?: boolean;
}

function plain(value: string): VarDef {
  return { value };
}
function sealed(configKey: string): VarDef {
  return { value: secrets.requireSecret(configKey), sealed: true };
}

function defineVariables(
  serviceName: string,
  environmentId: string,
  serviceId: string,
  vars: Record<string, VarDef>
): Record<string, railway.Variable> {
  const resources: Record<string, railway.Variable> = {};
  for (const [name, def] of Object.entries(vars)) {
    resources[name] = new railway.Variable(
      `${serviceName}-var-${name}`,
      { environmentId, serviceId, name, value: def.value },
      def.sealed ? { ignoreChanges: ["value"] } : undefined
    );
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
  regions: [{ region: "us-west2", numReplicas: 1 }],
});

defineVariables("minsky-mcp", minskyMcpEnv, minskyMcpServiceId, {
  MINSKY_APP_ID: plain("3436626"),
  MINSKY_APP_INSTALLATION_ID: plain("125403046"),
  MINSKY_GITHUB_APP_PRIVATE_KEY: sealed("minsky-github-app-private-key"),
  MINSKY_MCP_AUTH_TOKEN: sealed("minsky-mcp-auth-token"),
  MINSKY_MCP_MAX_SESSIONS: plain("1000"),
  MINSKY_PERSISTENCE_BACKEND: plain("postgres"),
  MINSKY_PERSISTENCE_POSTGRES_URL: sealed("minsky-persistence-postgres-url"),
  NODE_ENV: plain("production"),
  OPENAI_API_KEY: sealed("openai-api-key"),
  MINSKY_OAUTH_SIGNING_KEY: sealed("minsky-oauth-signing-key"),
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
  // Scope the deploy trigger to the reviewer's build/dependency closure via
  // Railway config-as-code `build.watchPatterns` (the provider exposes no
  // watch field). Without this the service redeploys on EVERY push to main,
  // and each restart drops in-flight GitHub->reviewer webhooks (mt#2345).
  configPath: "services/reviewer/railway.json",
  regions: [{ region: "us-west2", numReplicas: 1 }],
});

defineVariables("reviewer", reviewerEnv, reviewerServiceId, {
  MINSKY_REVIEWER_APP_ID: plain("3470137"),
  MINSKY_REVIEWER_INSTALLATION_ID: plain("126244115"),
  MINSKY_REVIEWER_PRIVATE_KEY: sealed("minsky-reviewer-private-key"),
  MINSKY_REVIEWER_WEBHOOK_SECRET: sealed("minsky-reviewer-webhook-secret"),
  MINSKY_REVIEWER_TIER2_ENABLED: plain("true"),
  REVIEWER_PROVIDER: plain("openai"),
  OPENAI_API_KEY: sealed("openai-api-key"),
  SWEEPER_ENABLED: plain("true"),
  REVIEWER_COMPOSITION_CONVERGENCE_ENABLED: plain("true"),
  MINSKY_MCP_URL: plain("https://minsky-mcp-production.up.railway.app/mcp"),
  MINSKY_MCP_AUTH_TOKEN: sealed("minsky-mcp-auth-token"),
  MINSKY_SESSIONDB_POSTGRES_URL: sealed("minsky-sessiondb-postgres-url"),
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
  regions: [{ region: "us-west2", numReplicas: 1 }],
});

defineVariables("site", siteEnv, siteServiceId, {
  NODE_ENV: plain("production"),
  // Real Railway serving URL. Custom marketing domain undecided (mt#2046);
  // do not set this to a domain we do not control (mt#2193). `minsky.dev` is
  // third-party-owned (verified 2026-05-31).
  SITE_URL: plain("https://minsky-site-production.up.railway.app"),
});

// ---------------------------------------------------------------------------
// cockpit preview (placeholder — Railway project not yet created, mt#2096)
// ---------------------------------------------------------------------------
// const cockpitService = new railway.Service("cockpit", {
//   projectId: "REPLACE_AFTER_CREATION",
//   name: "cockpit-preview",
//   regions: [{ region: "us-west2", numReplicas: 1 }],
// });
// defineVariables("cockpit", "REPLACE", "REPLACE", {
//   MINSKY_PERSISTENCE_BACKEND: plain("postgres"),
//   MINSKY_PERSISTENCE_POSTGRES_URL: sealed("minsky-cockpit-preview-postgres-url"),
//   MINSKY_COCKPIT_PREVIEW: plain("true"),
// });

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
export const services = {
  minskyMcp: { projectId: minskyMcpProject, serviceId: minskyMcpServiceId },
  reviewer: { projectId: reviewerProject, serviceId: reviewerServiceId },
  site: { projectId: siteProject, serviceId: siteServiceId },
};
