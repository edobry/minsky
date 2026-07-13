import * as pulumi from "@pulumi/pulumi";
import * as railway from "@pulumi/railway";

const secrets = new pulumi.Config("secrets");
// Project-namespaced plain config (minsky-infra:*). Per-stack operator
// settings live here (gitignored Pulumi.<stack>.yaml), not in this file.
const stackConfig = new pulumi.Config();
const telegramChatId = stackConfig.get("reviewer-telegram-chat-id");

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
  // minsky-mcp deploys from a GHCR image (sourceImage above), NOT from a
  // repo+Dockerfile, so Railway config-as-code (`config_path` / railway.json) is
  // INCOMPATIBLE here: Railway rejects `config_path` when `source_image` is set
  // ("Invalid Attribute Combination"), which blocks `pulumi up` (mt#2472).
  // Deploy-scoping for this image-based service lives entirely in
  // `.github/workflows/deploy-minsky-mcp.yml` `paths:` — the workflow builds +
  // pushes the GHCR image only on changes within the build closure; that is the
  // single source of truth. (mt#2461 added a config_path here by analogy to the
  // reviewer service — which IS repo+Dockerfile-source and so CAN use config-as-code
  // — and broke the prod stack; mt#2472 removed it.)
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
  // mt#2724: Braintrust observability credential — enables the reviewer's
  // per-review cost event emission (mt#2723, source="minsky.reviewer.cost") in
  // production. Without it, the shared emitBraintrustEvent gracefully no-ops.
  // Project name defaults to "minsky" (no BRAINTRUST_PROJECT_NAME needed).
  BRAINTRUST_API_KEY: sealed("braintrust-api-key"),
  SWEEPER_ENABLED: plain("true"),
  REVIEWER_COMPOSITION_CONVERGENCE_ENABLED: plain("true"),
  MINSKY_MCP_URL: plain("https://minsky-mcp-production.up.railway.app/mcp"),
  MINSKY_MCP_AUTH_TOKEN: sealed("minsky-mcp-auth-token"),
  // Canonical persistence config (mt#2463): the domain container reads
  // MINSKY_PERSISTENCE_POSTGRES_URL; without it the container boots in
  // DB-unavailable mode and every pr-watch scheduler cycle throws. Replaces
  // the deprecated MINSKY_SESSIONDB_POSTGRES_URL (sessiondb retired in
  // mt#1610) — the reviewer's own DB client prefers the canonical name and
  // both secrets resolve to the same prod database.
  MINSKY_PERSISTENCE_BACKEND: plain("postgres"),
  MINSKY_PERSISTENCE_POSTGRES_URL: sealed("minsky-persistence-postgres-url"),
  // Reviewer external alert sink (mt#2364 / mt#2419): pushes circuit-breaker
  // trips to the operator's Telegram after-hours. PER-STACK opt-in (PR #1672
  // R1): the chat id is an operator-specific identifier and the sink must not
  // default on — both live in the stack config (gitignored Pulumi.<stack>.yaml),
  // not in this shared file. Enable on a stack with:
  //   pulumi config set reviewer-telegram-chat-id <id>     (plain; discover
  //     via scripts/reviewer-alerts/discover-chat-id.ts)
  //   pulumi config set --secret secrets:minsky-reviewer-telegram-bot-token
  //     (masked; or via the cockpit credentials widget's Telegram provider)
  // When the chat id is unset, no alert vars are declared and the sealed
  // token is not required — stacks without the secret stay applyable.
  ...(telegramChatId
    ? {
        ALERT_SINK_TYPE: plain("telegram"),
        TELEGRAM_CHAT_ID: plain(telegramChatId),
        TELEGRAM_BOT_TOKEN: sealed("minsky-reviewer-telegram-bot-token"),
      }
    : {}),
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
// cockpit preview (mt#2096; project provisioned + IaC reconciled mt#2401)
// ---------------------------------------------------------------------------
const cockpitProject = "62db6727-ed10-415e-afc5-7188c9983c81";
const cockpitServiceId = "83273eef-b451-42af-b3e4-7e1c42b8bb50";

export const cockpitService = new railway.Service("cockpit", {
  projectId: cockpitProject,
  name: "cockpit-preview",
  sourceRepo: "edobry/minsky",
  sourceRepoBranch: "main",
  // Build context is the repo root — same pattern as services/reviewer (which
  // also OMITS rootDirectory). The Dockerfile lives at services/cockpit/Dockerfile
  // (build wiring in services/cockpit/deploy.config.ts). rootDirectory is OMITTED,
  // NOT set to "": Railway rejects an empty root_directory ("Invalid Attribute Value
  // Length ... must be at least 1, got: 0"), which blocked pulumi up entirely
  // (mt#2474). Omitting it = Railway default (repo root), matching the working
  // reviewer service (verified <unset> in the prod stack state).
  regions: [{ region: "us-west2", numReplicas: 1 }],
});

// Env-var IaC for cockpit-preview is deferred to mt#2407. Declaring a
// `defineVariables(...)` block here would `requireSecret(...)` the
// `minsky-cockpit-preview-postgres-url` Pulumi stack secret, which is not yet
// configured in the (gitignored) Pulumi.<stack>.yaml — a latent `pulumi up`
// break. Managing the live service's env vars is also out of scope for mt#2401
// (the live service already has its vars set out-of-band). Intended set
// (production env cc3d2bc3-13cc-4061-9633-cd58f48dc3fe), validated against
// services/cockpit/src/server.ts + the domain config-setup it boots:
//   MINSKY_PERSISTENCE_BACKEND=postgres
//   MINSKY_PERSISTENCE_POSTGRES_URL=<sealed: minsky-cockpit-preview-postgres-url>
//   MINSKY_COCKPIT_PREVIEW=true

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
export const services = {
  minskyMcp: { projectId: minskyMcpProject, serviceId: minskyMcpServiceId },
  reviewer: { projectId: reviewerProject, serviceId: reviewerServiceId },
  site: { projectId: siteProject, serviceId: siteServiceId },
  cockpit: { projectId: cockpitProject, serviceId: cockpitServiceId },
};
