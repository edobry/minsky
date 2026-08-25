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
  // mt#2132: widened from `string` to `pulumi.Input<string>` so a
  // newly-created service's `.id` (a `pulumi.Output<string>`, not known
  // until `pulumi up` runs) can be passed directly — the existing callers
  // below all pass hardcoded plain strings for already-provisioned
  // services, which remain valid under the wider type.
  serviceId: pulumi.Input<string>,
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

export const minskyMcpService = new railway.Service(
  "minsky-mcp",
  {
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
    // rootDirectory is ignored rather than declared or cleared, because neither is
    // possible. The live service carries rootDirectory: "/" left over from a
    // repo-source era. Pulumi cannot remove it: omitting an optional property sends
    // no clear instruction, so the API retains its value — a targeted `pulumi up`
    // reported "1 updated" and left state at inputs=ABSENT / outputs="/". Declaring
    // "/" to match is rejected at plan time, because rootDirectory conflicts with
    // sourceImage (infra/sdks/railway/service.ts) and this service is image-source.
    // A direct `railway environment edit` patch setting it null also failed to clear
    // it (mem#281 records this exact field silently no-opping). The property is inert
    // for an image deploy, so ignoring it states the truth — Pulumi does not own this
    // field — and stops THIS service from contributing a phantom diff. That is a
    // service-local claim, not a stack-wide one: cockpit still shows a residual
    // `- sourceRepo` for the same provider reason (mt#3318 owns clearing it). Every
    // phantom diff removed is one less reason to stop reading the plan at all.
    // Do NOT "fix" this by deleting the ignore; that restores a
    // permanent phantom diff. (mt#3318, mt#3832.)
  },
  { ignoreChanges: ["rootDirectory"] }
);

defineVariables("minsky-mcp", minskyMcpEnv, minskyMcpServiceId, {
  MINSKY_APP_ID: plain("3436626"),
  MINSKY_APP_INSTALLATION_ID: plain("125403046"),
  MINSKY_GITHUB_APP_PRIVATE_KEY: sealed("minsky-github-app-private-key"),
  MINSKY_MCP_AUTH_TOKEN: sealed("minsky-mcp-auth-token"),
  MINSKY_MCP_MAX_SESSIONS: plain("1000"),
  MINSKY_PERSISTENCE_BACKEND: plain("postgres"),
  // mt#2542 least-privilege role split: app binaries connect as the DML-only
  // `minsky_app` Postgres role (scripts/supabase-app-role.sql). The DDL-capable
  // `postgres` credential lives ONLY in Pulumi key
  // `minsky-persistence-postgres-url` + the MINSKY_PERSISTENCE_POSTGRES_URL
  // GitHub Actions secret (the deploy-keyed migrator). NOTE: sealed vars carry
  // `ignoreChanges: ["value"]`, so this declaration sets the value at resource
  // CREATION only — the live rotation to the minsky_app URL is done out-of-band
  // (`railway variables --set`), per the sealed-secret posture (mt#1442 runbook).
  MINSKY_PERSISTENCE_POSTGRES_URL: sealed("minsky-app-postgres-url"),
  NODE_ENV: plain("production"),
  OPENAI_API_KEY: sealed("openai-api-key"),
  MINSKY_OAUTH_SIGNING_KEY: sealed("minsky-oauth-signing-key"),
});

// ---------------------------------------------------------------------------
// minsky-ops (mt#2132)
// ---------------------------------------------------------------------------
// Runs the SAME GHCR image as minsky-mcp above, with a start-command
// override (`ops start` instead of `mcp start --http`) so it boots the
// background-loop / health-endpoint process (src/commands/ops/start-command.ts)
// instead of the MCP server. Same project + environment as minsky-mcp — this
// is a placeholder-topology decision recorded in services/minsky-ops/deploy.config.ts
// before this task (shared Postgres access, shared GHCR image lifecycle:
// `.github/workflows/deploy-minsky-mcp.yml`'s `src/**` path filter already
// covers `src/commands/ops/**`, so a push touching either service's code
// rebuilds+pushes the one shared `ghcr.io/edobry/minsky:latest` image that
// both services pick up independently on their own Railway-native redeploy).
//
// KNOWN GAP (verified against the generated Pulumi SDK at
// infra/sdks/railway/service.ts, mt#2132): the
// terraform-community-providers/railway bridge's `railway.Service` resource
// has NO `startCommand` (or any `deploy.*`) field — Railway's per-service
// deploy-settings concept (start command, healthcheck path, etc.) lives
// outside this simplified schema entirely, the same class of gap already
// documented on the reviewer service below for `deploy.healthcheckPath`.
// The start-command override is therefore set out-of-band via
// `railway environment edit --service-config minsky-ops deploy.startCommand
// "<command>"` (documented in services/minsky-ops/deploy.config.ts) — NOT
// expressible here, and NOT a `config_path` (which Railway rejects alongside
// `source_image`, per the minsky-mcp comment above).
//
// PORT (mt#2132, verified empirically): unlike the root Dockerfile's shell-form
// CMD (which Docker wraps in `/bin/sh -c "..."`, letting `$PORT` expand from
// Railway's injected env var), Railway's `deploy.startCommand` override does
// NOT go through a shell — `--port $PORT` in the override string arrives at
// the CLI as the LITERAL 5-character string `$PORT`, which fails
// `parsePositiveIntEnv`-style validation and crash-loops. The override
// therefore uses a LITERAL port matching this declared `PORT` variable, and
// Railway's edge networking (per its documented behavior, confirmed against
// minsky-mcp's own `targetPort: null` domain config) routes the public
// domain to whatever value the service's `PORT` variable holds — declaring
// it here makes the routing target and the app's actual listening port the
// same fixed value instead of depending on shell expansion.
export const minskyOpsService = new railway.Service("minsky-ops", {
  projectId: minskyMcpProject,
  name: "minsky-ops",
  sourceImage: "ghcr.io/edobry/minsky:latest",
  regions: [{ region: "us-west2", numReplicas: 1 }],
});

defineVariables("minsky-ops", minskyMcpEnv, minskyOpsService.id, {
  // Same domain-container bootstrap as minsky-mcp (both run createDomainContainer()
  // from the same bundle) — inherits the same credential set per
  // services/minsky-ops/deploy.config.ts's docstring ("Inherits all
  // minsky-mcp variables plus" the ADOPTION_SWEEPER_* family below).
  // MINSKY_MCP_MAX_SESSIONS is intentionally OMITTED — that variable only
  // governs the MCP-over-HTTP transport's session cap, which minsky-ops
  // never runs (it calls domain services directly, no callMcp()).
  MINSKY_APP_ID: plain("3436626"),
  MINSKY_APP_INSTALLATION_ID: plain("125403046"),
  MINSKY_GITHUB_APP_PRIVATE_KEY: sealed("minsky-github-app-private-key"),
  MINSKY_MCP_AUTH_TOKEN: sealed("minsky-mcp-auth-token"),
  MINSKY_PERSISTENCE_BACKEND: plain("postgres"),
  // mt#2542 least-privilege role split — same DML-only `minsky_app` role as
  // minsky-mcp (see that service's comment above for the full rationale).
  MINSKY_PERSISTENCE_POSTGRES_URL: sealed("minsky-app-postgres-url"),
  NODE_ENV: plain("production"),
  // Route info-level logs to stdout as JSON so Railway captures them. Without
  // this the default CLI logger mode keeps info logs off stdout and the
  // container is silent even when boot succeeds (observed during mt#2132
  // bring-up: zero log lines after "Starting Container").
  MINSKY_LOG_MODE: plain("STRUCTURED"),
  OPENAI_API_KEY: sealed("openai-api-key"),
  MINSKY_OAUTH_SIGNING_KEY: sealed("minsky-oauth-signing-key"),
  // Fixed listening/routing port — see the `minskyOpsService` comment above
  // for why this is a literal value rather than Railway's usual `$PORT`
  // shell-expansion convention.
  PORT: plain("8081"),
  // Adoption sweeper (mt#1630 loop, mt#2101 ops-service wiring, mt#3328
  // container-blindness fix). ADOPTION_SWEEPER_EXECUTE is DELIBERATELY NOT
  // set — the sweeper defaults to dry-run (mt#3328); flipping to execute is
  // an operator-reviewed step after mt#2132, not part of this task's scope.
  ADOPTION_SWEEPER_ENABLED: plain("true"),
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
  sourceImage: "ghcr.io/edobry/minsky-reviewer:latest",
  // mt#3117 — converted from repo-source (Railway's native GitHub webhook,
  // rebuilding on EVERY push to main matching the now-retired
  // railway.json's build.watchPatterns — mt#2345's original fix for
  // unsynchronized redeploys) to image-source, the SAME shape minsky-mcp
  // uses above. Deploy-scoping now lives entirely in
  // `.github/workflows/deploy-reviewer.yml`'s `paths:` filter — the
  // workflow builds, smoke-tests, migrates, and pushes the GHCR image only
  // on changes within the reviewer's build closure; that is the single
  // source of truth (mirrors the minsky-mcp comment above in intent).
  //
  // `configPath` is INTENTIONALLY DROPPED, not just omitted — Railway
  // rejects `config_path` when `source_image` is set ("Invalid Attribute
  // Combination"), the exact mt#2472 incident that removed minsky-mcp's own
  // config_path. `services/reviewer/railway.json` is retired for the same
  // reason (see services/reviewer/deploy.config.ts's mt#3117 comment).
  //
  // LIVE-STATE CAVEAT (historical, mt#1815/mt#2777 — both CLOSED 2026-08-25):
  // the live reviewer service's `configPath` had been independently observed
  // drifted to null in production — i.e. even the PRE-mt#3117 config-as-code
  // state was not reliably applying to the live service. `pulumi up`
  // against this declaration is what reconciles the live service to
  // sourceImage; running it, and flipping the dashboard's Settings > Source
  // to Docker Image, are documented OPERATOR follow-ups performed after
  // this PR merges (see services/reviewer/DEPLOY.md) — not an in-PR action.
  //
  // Verified 2026-08-25 — flip DONE, reconcile UNVERIFIED. Settles with: per-step, below.
  //
  // Both operator steps above remain mechanically correct; only their status
  // is recorded here, per `documentation-taxonomy.mdc §Operator-instruction
  // blocks carry a verification stamp`. Do NOT read "both tasks closed" as
  // "no operator step remains" — that is the exact inference mt#4392 exists
  // to prevent, and mt#4087 still owns retiring the flip.
  //   - Flip: DONE 2026-07-24 (mem#700/mem#717, the mt#3142 recovery).
  //     Settles with: `railway deployment list --json --service
  //     3913e8a4-81ab-465a-aad8-b76b5e3f66ed --environment
  //     b3ea3f5d-8560-40ea-8824-17fe3ca0b32a | jq -r '.[0].meta.image'`
  //     — a non-null image means image-source. The `--environment` flag is
  //     REQUIRED: without it the CLI falls back to the linked context, which
  //     may target a different environment and produce a false read.
  //   - Reconcile: UNVERIFIED. Settles with: a TARGETED `pulumi preview
  //     --target 'urn:pulumi:prod::minsky-infra::railway:index/service:Service::reviewer'`
  //     (blanket preview has a measured 6-change blast radius — mem#700).
  // Both commands match the ones in services/reviewer/DEPLOY.md's stamp
  // character-for-character once this comment's `//` wrapping is removed. Keep
  // them that way: a settler that differs between two artifacts is not
  // deterministic, which is the property this convention exists to provide.
  // The configPath drift itself is now MOOT rather than fixed: this service is
  // image-source, and Railway rejects `config_path` alongside `source_image`.
  // Full evidence: mt#1815 `## Findings`, mem#551.
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
  // mt#3245: deterministic verifier that demotes a BLOCKING duplicate-identifier /
  // duplicate-declaration finding to NON-BLOCKING when a declaration-FORM count (not
  // identifier occurrences) against the file's actual current content at the review ref
  // finds <=1 declaration. mt#3307: enabling it now — mt#3245 merged 2026-07-26 (PR #2334)
  // but this variable was never declared here, so the check has been deployed-but-inert;
  // mt#2575 instance 5 (PR #2325, 2026-07-26) is the incident it targets.
  REVIEWER_STRUCTURAL_CLAIM_VERIFICATION_ENABLED: plain("true"),
  // mt#3471: narrow a re-review round (R>=2) to the commits pushed since the
  // last posted review, instead of re-sending the whole PR diff every round.
  // Approved as a cost lever in ask#6603 — re-review rounds are ~68% of the
  // reviewer's LLM calls and ~68% of its spend, at a median 412K input tokens
  // each, only ~7% below a first review's. Any unresolvable range (force-push
  // orphaning the base, a truncated or 5xx comparison) falls back to the full
  // diff, so the failure mode is today's cost, not a narrowed review.
  //
  // Deliberately NOT the same flag as REVIEWER_DIFF_SCOPE_BOUNDED_ENABLED
  // (mt#1875), which additionally arms a severity-downgrade pass that changes
  // what the reviewer BLOCKS on. That one stays undeclared and off.
  REVIEWER_INCREMENTAL_DIFF_ENABLED: plain("true"),
  // mt#2799: zero-downtime redeploy drain/overlap. Originally declared to
  // DUPLICATE services/reviewer/railway.json's `deploy.drainingSeconds` /
  // `deploy.overlapSeconds` as a belt-and-suspenders measure, because the
  // live reviewer service's `configPath` had been observed drifted to null
  // in production (memory mt1815_soak_still_failing_2026_07_15 = mem#627,
  // tracked as mt#1815/mt#2777 SC#3). Both tasks CLOSED 2026-08-25 and
  // mem#627 is SUPERSEDED — its finding was resolved by mt#3117 making the
  // field inapplicable, not by repairing the drift. mem#551 carries the
  // current mechanism and diagnostic; do not act on mem#627 as current.
  //
  // mt#3117 UPDATE: `services/reviewer/railway.json` is now RETIRED (the
  // service converted from repo-source to image-source deploy — Railway
  // rejects `config_path` alongside `source_image`; see this file's
  // `reviewerService` resource comment). These two service variables are
  // therefore no longer a belt-and-suspenders duplicate of anything — they
  // are the SOLE declarative source for drain/overlap now (still a plain
  // Railway service-variable mechanism, unaffected by the configPath
  // question, which no longer applies at all). Values unchanged: 300s
  // draining covers a typical review (kill-test target <30s recovery +
  // normal review latency ~60-90s, well under 300s); 60s overlap gives the
  // new deployment time to pass its healthcheck and start draining the old
  // one gracefully. `deploy.healthcheckPath` has NO service-variable
  // equivalent and, with railway.json gone, now has NO config-as-code
  // declaration at all — the same gap minsky-mcp's image-source service
  // already has (see that service's comment above). One-time dashboard
  // verification of the healthcheck path is an operator follow-up
  // (services/reviewer/DEPLOY.md), not something this file can declare.
  RAILWAY_DEPLOYMENT_DRAINING_SECONDS: plain("300"),
  RAILWAY_DEPLOYMENT_OVERLAP_SECONDS: plain("60"),
  MINSKY_MCP_URL: plain("https://minsky-mcp-production.up.railway.app/mcp"),
  MINSKY_MCP_AUTH_TOKEN: sealed("minsky-mcp-auth-token"),
  // Canonical persistence config (mt#2463): the domain container reads
  // MINSKY_PERSISTENCE_POSTGRES_URL; without it the container boots in
  // DB-unavailable mode and every pr-watch scheduler cycle throws. Replaces
  // the deprecated MINSKY_SESSIONDB_POSTGRES_URL (sessiondb retired in
  // mt#1610) — the reviewer's own DB client prefers the canonical name and
  // both secrets resolve to the same prod database.
  MINSKY_PERSISTENCE_BACKEND: plain("postgres"),
  // mt#2542: DML-only minsky_app role — see the minsky-mcp block above.
  MINSKY_PERSISTENCE_POSTGRES_URL: sealed("minsky-app-postgres-url"),
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
  // No repo source is declared, deliberately. This service is deployed only by
  // .github/workflows/cockpit-preview.yml (`railway up --service cockpit-preview`)
  // on each PR push, into ONE shared environment where each deploy overwrites the
  // previous one. Declaring sourceRepo + sourceRepoBranch would arm a second,
  // Railway-native auto-deploy on every push to the connected branch — with none of
  // the workflow's path scoping — so a push to main would stomp an in-review PR's
  // preview. minsky-site above shows that mechanism working as intended: it has no
  // deploy workflow at all, so repo+branch IS its entire deploy trigger.
  // The two properties go together because the schema requires the branch whenever
  // sourceRepo is set; declaring only one risks a plan-time "Invalid Attribute
  // Combination" (mt#2472). `railway up` builds from the CI checkout, so dropping
  // the dashboard repo link costs nothing.
  // rootDirectory stays OMITTED rather than "": Railway rejects an empty
  // root_directory ("Invalid Attribute Value Length ... must be at least 1, got: 0"),
  // which blocked pulumi up entirely (mt#2474).
  regions: [{ region: "us-west2", numReplicas: 1 }],
  // NOTE: do NOT add `ignoreChanges: ["sourceRepo"]` here. It looks like the right
  // parallel to minsky-mcp's rootDirectory ignore below, and it is not: ignoring the
  // property keeps the live repo link in the DESIRED state while no branch is
  // declared, so refresh fails the schema's pairing constraint outright —
  // `Invalid Attribute Combination. Attribute "source_repo_branch" must be specified
  // when "source_repo" is specified` (verified by preview, mt#3832; the mt#2472
  // breakage class). Leaving both undeclared is correct: preview shows a residual
  // `- sourceRepo` that the provider cannot express as a clear, which is harmless —
  // it is the branch, not the repo link, that would arm an unwanted deploy trigger.
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
  minskyOps: { projectId: minskyMcpProject, serviceId: minskyOpsService.id },
  reviewer: { projectId: reviewerProject, serviceId: reviewerServiceId },
  site: { projectId: siteProject, serviceId: siteServiceId },
  cockpit: { projectId: cockpitProject, serviceId: cockpitServiceId },
};

// Stack output so the real serviceId is discoverable after `pulumi up`
// creates it (mt#2132) — `pulumi stack output minskyOpsServiceId` — without
// needing to query the Railway API/dashboard to find it.
export const minskyOpsServiceId = minskyOpsService.id;
