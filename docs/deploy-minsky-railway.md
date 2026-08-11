# Deploying Minsky MCP to Railway

Run Minsky's MCP server as a network-reachable HTTP service on Railway. External agents (the `minsky-reviewer` webhook service, future non-Claude-Code harnesses, mesh peers) can then query Minsky state over HTTP instead of requiring a local install.

This is the deployment guide for mt#1129. For the architectural context, see §"Why HTTP transport" below.

## Architecture in one paragraph

Minsky's MCP server is transport-agnostic — the same tool registry serves stdio (for local Claude Code) and HTTP (for remote agents). The CLI flag `--http` selects the HTTP transport; `--require-auth` enables a bearer-token check on the `/mcp` endpoint. Railway wraps all of this in a container and auto-deploys on `main`. The `/health` endpoint stays public for Railway's uptime probes.

## What ships in the image: the bundle and its source map (mt#3023)

The root `Dockerfile` builds the CLI into `dist/minsky.js` at image-build time and the `CMD` execs that bundle directly — `bun run dist/minsky.js mcp start --http ...`, with no preload flag. Two artifacts land in the image, and **both are intentional**:

**Do not add `--preload reflect-metadata` back to the `CMD`.** It was there from mt#3561 until mt#3680, because bun's bundler emitted reflect-metadata's CommonJS require after the init calls that reach tsyringe, so the bundle could not boot on its own. mt#3680 fixed that ordering inside the bundle (`src/reflect-polyfill.ts`). Re-adding the flag would not be merely redundant: a preloaded invocation boots whether or not the bundle is self-sufficient, so it would make production the one place that never exercises the real path — and would silently disarm the bundle-boot smoke, which gates on this exact command.

| Artifact             | Approx. size | Why it is there                                  |
| -------------------- | ------------ | ------------------------------------------------ |
| `dist/minsky.js`     | ~26 MB       | The bundle the container runs. Built `--minify`. |
| `dist/minsky.js.map` | ~57 MB       | The external source map. **Do not strip it.**    |

**The map is shipped on purpose, and removing it is a regression, not a cleanup.** Bun uses it to symbolicate stack traces from the minified bundle back to the original `src/**.ts` file and line. Without it, a production trace degrades to minified single-line offsets into `dist/minsky.js` and Bun logs `note: missing sourcemaps` — which is precisely the position you do not want to be in while reading Railway logs during an incident. Every production-down incident in this repo so far (mt#1763, mt#1785, mt#2345) was diagnosed from deployed logs.

**Size tradeoff, stated plainly.** Keeping the map costs more than minifying saves: before mt#3023 the image carried a 37.5 MB unminified bundle and no map; it now carries ~82.5 MB across the two files, a net **+45 MB**. That was accepted deliberately — layer size is paid once per build, an unreadable stack trace is paid under time pressure. If a future change wants that 57 MB back, the honest framing is "we are trading production diagnosability for image size," not "we are removing a build artifact nobody needs." Note also that stripping the map while leaving `--minify` in place is the **worst** of the three options: it is strictly worse than the pre-mt#3023 state, which at least had readable (if unmapped) bundled traces.

The build flags are deliberately identical across all three `bun build` sites (`package.json`'s `build` script, `scripts/cli-entry.ts`'s source-install self-rebuild, and this Dockerfile). They are hand-maintained today; **mt#3091** tracks removing that duplication.

## Prerequisites (one-time)

1. **Railway CLI**: `brew install railway` or `bash <(curl -fsSL cli.new)`.
2. **Railway account** with a workspace you can deploy under.
3. **GitHub App grant for Railway**: the Railway GitHub App must be installed on `edobry/minsky` (same grant as mt#1107). Verify at <https://github.com/settings/installations>.
4. **Auth token**: `openssl rand -hex 32` — this becomes `MINSKY_MCP_AUTH_TOKEN`. Distribute only to trusted service consumers.
5. **Supabase Postgres URL**: the same connection string Minsky uses locally. Copy from `~/.config/minsky/config.yaml` (the `persistence.postgres.connectionString` field) or your local env.

> **Getting a Railway dashboard URL: use `railway open --print`, not a hand-composed URL
> (mt#3142).** `railway open --print` prints the dashboard URL for the linked project/service
> without opening a browser — use it whenever a doc, ask, or runbook needs to send an operator to
> the Railway console. A hand-composed `https://railway.com/project/<id>` **returns 404**: the
> working URL requires an `?environmentId=<id>` query parameter that a bare project-id URL omits.
> This bit an operator-facing ask during the 2026-07-23/24 reviewer incident (mt#3142) — the link
> was constructed by hand instead of obtained from the CLI, and the ask shipped with a dead link,
> costing a principal round-trip during an active outage.

## First deploy

```bash
cd /path/to/minsky
railway login
railway init --name minsky-mcp
railway up --detach -m "Initial deploy"
```

Railway auto-detects the `Dockerfile` at repo root and builds from it.

## Managing environment variables (canonical path)

**Use Pulumi (`infra/index.ts`), not `railway variables --set`.**

All production env-var state is declared in `infra/index.ts` using the Pulumi Railway provider (mt#2110). Direct `railway variables --set` calls are error-prone (no audit trail, no idempotency, values drift silently) and should not be used for ongoing management.

### Pulumi workflow

```bash
cd infra

# One-time per machine: log in to Pulumi Cloud (the prod stack's state backend,
# mt#2738) and install deps + regenerate the Railway TF-bridge SDK.
pulumi login                              # https://app.pulumi.com
pulumi install

# Preview changes (dry-run). No passphrase — config secrets decrypt via your
# Pulumi Cloud token (managed-KMS, mt#2738). railway:token comes from the
# committed Pulumi.prod.yaml, so there's no per-machine `config set` step.
pulumi preview --refresh --stack edobry/minsky-infra/prod

# Apply changes (still a manual operator step in Phase 1)
pulumi up --refresh --stack edobry/minsky-infra/prod
```

Pulumi:

1. Reads `infra/index.ts` (desired state)
2. Refreshes live Railway state via the TF provider's Railway API calls
3. Computes a diff and prints it
4. On `pulumi up`: applies creates/updates/deletes and records new state

> **Backend, secrets, and CI (mt#2738).** The `prod` stack's state lives in
> **Pulumi Cloud** (`edobry/minsky-infra/prod`), not a local `file://~` backend.
> Config secrets are encrypted with Pulumi Cloud's **managed KMS** key (not a
> passphrase), so `infra/Pulumi.prod.yaml` is **committed** (ciphertext) and no
> `PULUMI_CONFIG_PASSPHRASE` is needed anywhere. CI runs `pulumi preview` on every
> PR touching `infra/**` (`.github/workflows/infra-preview.yml`) and a daily drift
> check (`infra-drift-cron.yml`) that opens a GitHub issue on drift. **Applying is
> still manual** (the `pulumi up` above) — apply-on-merge is deferred to Phase 2.
> CI authenticates via the `PULUMI_ACCESS_TOKEN` repo secret.

### Secret handling

Secret variables (tagged `secret("ENV_VAR_NAME")` in the config) are resolved at apply-time from:

1. `process.env[ENV_VAR_NAME]` (highest priority)
2. `~/.config/minsky/railway-secrets.json` (fallback)
3. Hard failure if neither source has the value

To populate `~/.config/minsky/railway-secrets.json`, create it manually with the actual secret values:

```json
{
  "MINSKY_MCP_AUTH_TOKEN": "<token>",
  "MINSKY_GITHUB_APP_PRIVATE_KEY": "<private-key-pem>",
  "MINSKY_PERSISTENCE_POSTGRES_URL": "<supabase-url-postgres-role>",
  "MINSKY_APP_POSTGRES_URL": "<supabase-url-minsky-app-role>",
  "MINSKY_POSTGRES_URL": "<supabase-url>",
  "MINSKY_SESSIONDB_POSTGRES_URL": "<supabase-url>",
  "OPENAI_API_KEY": "<key>",
  "MINSKY_OAUTH_SIGNING_KEY": "<jwk-json-string>"
}
```

> **Two Postgres credentials since mt#2542 (least-privilege role split):** > `MINSKY_PERSISTENCE_POSTGRES_URL` in this file is the DDL-capable `postgres`
> role — used ONLY by the deploy-keyed migrator (GitHub Actions secret) and
> explicit local `persistence migrate`. `MINSKY_APP_POSTGRES_URL` is the
> DML-only `minsky_app` role (`scripts/supabase-app-role.sql`) — the value the
> runtime services' `MINSKY_PERSISTENCE_POSTGRES_URL` env var is set to (same
> env-var NAME on the services, different role than the migrator's). Local app
> config (`~/.config/minsky/config.yaml`) should also use the `minsky_app` URL.

#### Switchover runbook (mt#2542)

Because sealed vars carry `ignoreChanges: ["value"]`, changing the sealed
source in `infra/index.ts` does NOT rotate a live service — the switch to the
`minsky_app` credential is an explicit per-service rotation. Old and new
credentials are both valid throughout, so each step is independently
reversible.

1. Create the role (once): `psql "$ADMIN_URL" -v app_password="$APP_PW" -f scripts/supabase-app-role.sql`,
   then store the `minsky_app` URL as `MINSKY_APP_POSTGRES_URL` in
   `~/.config/minsky/railway-secrets.json` and as the Pulumi secret
   `secrets:minsky-app-postgres-url` (`pulumi config set --secret`, value via
   stdin).
2. Switch the reviewer service (smaller blast radius first):
   `jq -rj '."MINSKY_APP_POSTGRES_URL"' ~/.config/minsky/railway-secrets.json | railway variables --set-from-stdin MINSKY_PERSISTENCE_POSTGRES_URL -s <reviewer-service-id> -e <reviewer-env-id>`
   — then verify the triggered redeploy reaches SUCCESS and `/health` is 200.
3. Switch minsky-mcp the same way; verify deploy SUCCESS + `/health`.
4. Switch operator-local `~/.config/minsky/config.yaml` to the `minsky_app`
   URL (local MCP/CLI/sessions).
5. Final check: with the service credential, `CREATE TABLE` must be denied
   (`psql "$APP_URL" -c 'CREATE TABLE probe(i int)'` → `permission denied`).

**Rollback (any step):** set the service's `MINSKY_PERSISTENCE_POSTGRES_URL`
back to the `postgres`-role URL the same way — the DDL credential remains
valid; nothing else changes.

Secret vars are stored encrypted in Pulumi config (`pulumi config set --secret secrets:<key> <value>`) and applied with Railway's sealed variable semantics. After sealing, the Railway dashboard and CLI hide the value (write-only).

### Initial setup (one-time only)

For a brand-new Railway service with no variables set, the legacy `railway variables --set` form is acceptable for initial bootstrap:

```bash
# Auth — REQUIRED when using the --require-auth flag (which the default Dockerfile CMD enables)
railway variables --set MINSKY_MCP_AUTH_TOKEN=<output-of-openssl-rand-hex-32>

# Persistence — BOTH vars required.
railway variables --set MINSKY_PERSISTENCE_BACKEND=postgres
railway variables --set MINSKY_PERSISTENCE_POSTGRES_URL=<your-supabase-postgres-url>
```

After initial bootstrap, switch to Pulumi: run `pulumi preview --refresh` to verify the state matches production, then use `pulumi up --refresh` for all subsequent changes.

> **Why two vars:** the persistence layer reads `persistence.backend` (the backend selector) and `persistence.postgres.connectionString` (the URL) as separate fields. The legacy single-var shortcut (`MINSKY_POSTGRES_URL` — populating only the connection string) does not change the backend selector. Historically (pre-mt#2339) this silently fell back to a SQLite default with every schema-dependent MCP call failing with `no such table: ...` (mt#1224); since SQLite's removal, an unset/incorrect backend selector now surfaces as an explicit "PostgreSQL configuration required" error at boot instead of a silent fallback — set both vars regardless.
>
> **Legacy `MINSKY_SESSIONDB_*` env vars** (`_BACKEND`, `_POSTGRES_URL`, `_SQLITE_PATH`) are still accepted for back-compat with older deploys and user configs, but emit a deprecation warning on load. Prefer `MINSKY_PERSISTENCE_*` for new deployments.

Trigger a redeploy after setting variables:

```bash
railway redeploy
```

## Generate a public URL

```bash
railway domain
```

Copy the generated `https://<service>.up.railway.app`.

## Production deploy (auto-deploy from main)

Steady state: commits to `main` that touch the Minsky source trigger a Railway rebuild automatically. Configure this via the `DeploymentTriggerCreate` mutation against the Railway API — the CLI does not expose a first-class command at 4.40.x.

Project and service IDs are printed at `railway up` time; inspect with:

```bash
railway status --json
```

GraphQL mutation (see `services/reviewer/DEPLOY.md` for a full worked example against `backboard.railway.com/graphql/v2`):

```json
{
  "input": {
    "projectId": "<project-id>",
    "environmentId": "<production-env-id>",
    "serviceId": "<service-id>",
    "branch": "main",
    "repository": "edobry/minsky",
    "provider": "github"
  }
}
```

**Critical ordering gotcha (from `feedback_railway_config.md`):** if `source.rootDirectory` needs to be set, set it via JSON patch BEFORE creating the deployment trigger. Trigger creation fires an immediate build using whatever rootDirectory is currently on the service; missing config → build from the wrong directory → service crashes. For Minsky at repo root, `rootDirectory` defaults to `/` and no config is needed.

### Two services ride `ghcr.io/edobry/minsky:latest` — both must be redeployed (mt#3933)

`services/minsky-mcp/deploy.config.ts` and `services/minsky-ops/deploy.config.ts`
declare the **same** image tag, in the same Railway project and environment.
They differ only by a start-command override (minsky-ops runs `ops start`;
minsky-mcp runs the image's own `CMD`), which lives in dashboard-only state
(mt#3848). `services/reviewer` is on a separate tag
(`ghcr.io/edobry/minsky-reviewer:latest`) and is deployed by
`deploy-reviewer.yml`.

Pushing the tag does not deploy anything by itself — a redeploy has to be
triggered per service, and `railway redeploy` alone replays the existing
deployment snapshot. Only `railway redeploy --from-source` re-resolves the tag
(`railway redeploy --help`: "Pull and deploy the latest commit or image from the
configured source, instead of redeploying the existing deployment"; the
snapshot-replay half is recorded in mem#700).

**`deploy-minsky-mcp.yml` therefore redeploys every service on the tag**, and
its `Trigger Railway redeploy` step carries a coverage guard: if any
`services/*/deploy.config.ts` declares this image **in this same project and
environment** and is missing from the workflow's `REDEPLOY_SERVICES` list, the
deploy FAILS rather than silently leaving that service on a stale image. The
project/environment half of that test is not incidental — a variant riding the
same base tag in a different Railway project is outside this job's reach (it
holds one project+environment), so flagging it would fail a production deploy
over a service this workflow could not have redeployed anyway. Until 2026-08-11 the step redeployed
only minsky-mcp, and minsky-ops served one image from 2026-07-31 to 2026-08-10
— SUCCESS on Railway and 200 on `/health` throughout, visible only to the
digest comparison in the post-deploy health monitor.

Re-verify the wiring without a deploy:

```bash
bun scripts/verify-deploy-redeploy-coverage.ts
```

That script extracts the workflow's actual bash and runs it against a stub
`railway` binary, so it checks the shipping code rather than a copy of it.

**Railway's native "Image Auto Updates" is the vendor-canonical alternative and
was deliberately not used.** It supports `ghcr.io` and watches non-semver tags
for new pushes, but enablement is dashboard-only (no API or config-as-code
path), and its detection is cached "up to a few hours"
(`docs.railway.com/deployments/image-auto-updates`). Both are disqualifying
here: this repo deploys on every merge to main, and dashboard-only state is the
standing problem in this service pair (mt#3848), not an acceptable home for new
deploy behavior.

## Standing deployment triggers vs `sourceImage` (mt#3142)

A Railway service can hold `source.image` (an explicit image-source deploy) **and** a standing
native GitHub deployment trigger **at the same time** — the two are independent objects on the
service, and the trigger deploys on every push to its configured branch **independently of the
declared source**. Declaring `source.image` (in Pulumi or the dashboard) does not disconnect,
disable, or supersede a trigger that was registered earlier — it only changes what an _explicit_
deploy resolves to. If the trigger is still registered, a push to the branch fires its own build,
and if no dockerfile path is pinned for that build, Railway falls back to auto-detecting a
Dockerfile from the repo — which is not necessarily the one the target service is supposed to run.

This was the mechanism behind the 2026-07-23/24 reviewer wrong-image incident (mt#3142): the
reviewer service (`minsky-reviewer-webhook`) had `source.image` pointing at
`ghcr.io/edobry/minsky-reviewer:latest`, but a standing GitHub deployment trigger predating the
image-source migration was still registered on the service. Pushes to `main` kept firing that
trigger, which built the repo-root `Dockerfile` (the Minsky MCP server image, not the reviewer's)
and deployed it onto the reviewer's host — so the reviewer intermittently served the wrong
application even though its declared source was correct. `GET /health` returned 200 throughout,
because the wrong application also serves a generic healthy response; only a reviewer-specific
signal (e.g. `POST /retrigger` reachability, or the health body's `service` field, see the
"Continuous monitoring" section above) could tell the two states apart.

### Setting `sourceRepo: null` does not delete the trigger

Setting `source.sourceRepo: null` on the Pulumi `Service` resource does **not** cascade-delete the
standing trigger object. The trigger has its own lifecycle, independent of the `Service`
resource's `sourceRepo`/`sourceImage` fields, and survives a Pulumi apply that clears them.
Disconnecting the repo source through `infra/index.ts` is necessary but not sufficient to stop
trigger-fired builds — the trigger itself has to be removed separately.

### Pulumi's generated Railway SDK cannot see or manage the trigger, or `dockerfilePath`

The generated Railway SDK Pulumi uses exposes no resource for the
deployment-trigger object at all. (That SDK lives at `infra/sdks/railway/` **on a working
machine only** — `infra/.gitignore` ignores `/sdks/`, so the path is NOT present at HEAD and a
fresh checkout will not have it. Regenerate it with `pulumi install`, which builds the SDK from
the `packages: railway:` declaration in `infra/Pulumi.yaml`. Gitignoring the generated SDK and
regenerating on demand is Pulumi's own documented Local Packages guidance — see mt#2449.)
Its full resource set is: `customDomain`, `environment`,
`project`, `provider`, `service`, `serviceDomain`, `sharedVariable`, `tcpProxy`, `variable`,
`variableCollection` — there is no `deploymentTrigger` resource. The `Service` resource's field
set is: `configPath`, `cronSchedule`, `name`, `projectId`, `regions`, `rootDirectory`,
`sourceImage`, `sourceImageRegistryUsername`, `sourceImageRegistryPassword`, `sourceRepo`,
`sourceRepoBranch`, `volume` — there is no `dockerfilePath` field either.

**Consequence:** because the provider has no `dockerfilePath` field, a Pulumi-managed `Service`
update silently **drops** a dockerfile path that was set out-of-band (e.g. via `railway.json` or
the dashboard) — Pulumi has no field to preserve, so it doesn't know one existed. This is the same
failure class as mt#2352 ("Railway config-as-code does NOT field-merge `dockerfilePath`"), reached
by a different path: mt#2352 hit it through `railway.json`, this incident hit it through Pulumi.

Because Pulumi cannot represent or manage the trigger object, removing a standing trigger is
out-of-band of `infra/index.ts`. Railway documents disconnecting the GitHub source from the
**dashboard** (Settings → Source) as the supported way to make a service a pure image runner:

- <https://docs.railway.com/deployments/github-autodeploys>
- <https://docs.railway.com/services>

### Belt-and-suspenders: `RAILWAY_DOCKERFILE_PATH`

The live reviewer service also has the service variable
`RAILWAY_DOCKERFILE_PATH=services/reviewer/Dockerfile` set. Railway documents this env var as a
build-time override that pins the Dockerfile path for a build even when it falls back to
auto-detection — so if a standing trigger ever fires again, the resulting build should resolve to
the reviewer's own Dockerfile instead of the repo root. This is **vendor-documented and set, but
has never actually been exercised by a real trigger-fired repo build** — treat it as
strong-evidence, not live-verified, unless and until a trigger-fired build is observed picking it
up.

As of 2026-07-28 the reviewer deploy pipeline is confirmed working end-to-end through its intended
path: `.github/workflows/deploy-reviewer.yml` deploys the reviewer on merge using a per-project
`RAILWAY_REVIEWER_TOKEN` (mt#3251), and the deployed image digest matches
`ghcr.io/edobry/minsky-reviewer:latest` with `/health` returning the reviewer's own identity. The
`RAILWAY_DOCKERFILE_PATH` variable above remains a defense-in-depth measure against a
trigger-fired build, not evidence that one has occurred.

### Sequencing rule: apply the new state and verify it live before removing the old pin

The incident above generalizes into a rule for the next source migration on any service: **apply
the new source state and verify it live BEFORE removing the old pin.** A config that PINS build
behavior — a `dockerfilePath`, a `railway.json`, a version constraint, a branch filter — must not
be deleted until the state it is being migrated TO is live and confirmed. With the pin gone and
the new state not yet applied, the window's behavior is the platform DEFAULT — which for a Railway
repo-source build is the repo-ROOT Dockerfile, i.e. an entirely different application.

Correct order: **apply the new state → verify it live → then remove the old pin.**

"Verify it live" means reading the platform's own record of the service, not inferring from the
declaration you just applied. Applying config and observing the intended runtime state are two
different facts. Concretely, for a Railway source migration:

```bash
railway status --json | jq '.environments.edges[0].node.serviceInstances.edges[]
  | select(.node.serviceName=="<service>")
  | {source: .node.source, commit: .node.latestDeployment.meta.commitHash}'
```

- `source` must show the NEW shape (e.g. `{repo: null, image: "ghcr.io/..."}`), not the old one.
- `commitHash: null` on the latest deployment means it came from an IMAGE; a non-null
  `commitHash` means a REPO build still produced it — the fastest way to tell what actually
  shipped.

Then confirm the running service is the one you expect via its `/health` body, not merely a 200
(mt#3148) — a generic 200 is served by the wrong application too.

mt#3117 deleted `services/reviewer/railway.json` in the same PR that declared the reviewer service
image-source, while the live service was still repo-source; the next unrelated merge to `main`
fired the standing repo trigger described above, Railway fell back to the repo-root Dockerfile,
and the Minsky MCP Server was deployed onto the reviewer host. See mem#747 for the full analysis.

## Database migrations on deploy (mt#2505)

Prod schema migrations are applied by a **single, deploy-keyed step** in
`.github/workflows/deploy-minsky-mcp.yml`, not by every binary on boot. On a
push to `main`, the `Apply migrations to production` step runs
`persistence migrate --execute` **inside the freshly-built `:ci` image**, against
the prod database, **before** the `:latest` image is pushed (which is what
triggers the Railway deploy). So migration **gates** the deploy:

```
build :ci → boot+/health smoke → migrate prod → (only on success) push :latest → Railway deploys
```

Failure of the migration fails the job → the image is never pushed → Railway
keeps running the prior version against the unchanged schema. This is the
Heroku/GitLab "release phase" pattern.

### Required secret

The step needs the prod Postgres connection as a repo Actions secret:

- **`MINSKY_PERSISTENCE_POSTGRES_URL`** — the DDL-capable `postgres` role
  credential (Pulumi secret `minsky-persistence-postgres-url`). Since mt#2542
  this is deliberately NOT the same value as the services' sealed var: the
  services run as the DML-only `minsky_app` role (Pulumi secret
  `minsky-app-postgres-url`; `scripts/supabase-app-role.sql`), so this GitHub
  Actions secret is the only DDL credential stored in CI. The bundle reads this
  canonical var (NOT `MINSKY_POSTGRES_URL`/`DATABASE_URL`; mt#2439). The value
  is forwarded into the migrate container by name and is never echoed; GitHub
  auto-masks `secrets.*` in logs.

Set it with:

```bash
# value piped from the operator secret store; never printed. Do NOT copy the
# service's live var — post-mt#2542 that's the DML role, which cannot migrate.
jq -rj '."MINSKY_PERSISTENCE_POSTGRES_URL"' ~/.config/minsky/railway-secrets.json \
  | gh secret set MINSKY_PERSISTENCE_POSTGRES_URL --repo edobry/minsky
```

### Backward-compatibility policy (REQUIRED — expand-contract)

Because migration runs **before** the new code is live — and because sibling
services (reviewer, cockpit) share the one prod database and deploy on their own
schedule — **every migration MUST be backward-compatible** with the
currently-running code (the "expand" half of expand-contract):

- **Additive first:** add columns/tables/indexes; do NOT drop or rename a column
  the running code still reads, and do NOT add a `NOT NULL` column without a
  default in the same migration.
- **Destructive changes are a SECOND migration**, shipped only after all
  services run the new code that no longer needs the old shape.

This requirement is not new with mt#2505 — the prior auto-migrate-on-boot model
already produced an old-code-vs-new-schema skew across services (each service
self-migrated on its own boot). mt#2505 makes the single-runner explicit; the
expand-contract discipline is what keeps the deploy window safe.

#### Extended to the reviewer's own migrations (mt#3117)

The reviewer service (`minsky-reviewer-webhook`) now has its **own**
deploy-keyed migration step — `.github/workflows/deploy-reviewer.yml`, applying
`services/reviewer/migrations/pg` via a **separate** tracking table
(`drizzle.__drizzle_migrations_reviewer`, mt#1967) using the same
`MINSKY_PERSISTENCE_POSTGRES_URL` DDL-capable `postgres` credential this
workflow uses. Same release-phase mechanism (migrate before push gates the
deploy), independent migration tree, **same shared prod Postgres database**.

The expand-contract requirement above therefore applies to reviewer migrations
too, and for the same reason: the reviewer and the main domain read each
other's data out-of-band (cross-service reads against the shared database —
the reviewer's convergence-metrics / webhook-events tables and the main
domain's `tasks` / session tables are queried by both surfaces at different
times, not synchronized to a single deploy). A destructive reviewer migration
(dropping/renaming a column the main domain reads, or vice versa) can break
the other service even though the two deploy workflows are otherwise fully
independent and run on their own schedules.

**No cross-tree ordering primitive exists.** `deploy-minsky-mcp.yml` and
`deploy-reviewer.yml` are two independent, uncoordinated release pipelines —
each gates its OWN tree against its OWN schema state, but neither knows about
the other's pending migrations. If a single logical change requires a
main-tree migration and a reviewer-tree migration to land in a specific
relative order, that ordering must be enforced MANUALLY by sequencing the two
merges/deploys — there is no automated coupling. (This is explicitly listed as
NOT covered by mt#3117's own recovery-layer discipline; file a task if such a
cross-tree-ordered change is attempted and no owner exists yet.)

### Guardrails (in the workflow)

- **Timeout:** the migrate container is wrapped in `timeout 600` — a hung
  connection/lock fails the deploy fast instead of stalling for hours.
- **No mid-migration cancellation:** the workflow's `concurrency` block sets
  `cancel-in-progress: false`, so a new push queues behind an in-flight deploy
  rather than cancelling a running migration.
- **Single-runner + idempotent:** the `concurrency` group serializes deploys,
  and drizzle's high-water-mark migrator is a no-op when nothing is pending, so
  a retried run resumes safely.

> **Sequencing note:** `MINSKY_AUTO_MIGRATE` now defaults **OFF** (mt#2560), so
> the container no longer self-migrates on boot — this deploy-keyed step is the
> sole prod migrator. Auto-migrate-on-boot remains available as an explicit
> opt-in (`MINSKY_AUTO_MIGRATE=1`) for a local/dev/throwaway DB you solely own.

## OAuth runbook (mt#1634, shipped May 2026)

The hosted Minsky MCP supports OAuth 2.1 in addition to the static-bearer-token path. claude.ai web requires the OAuth flow as a precondition for adding remote MCP servers; mt#1634 shipped the full discovery + DCR + PKCE + RFC 8707 audience-binding flow backed by `oidc-provider`.

### Required env vars

The InProcessOAuthProvider works with minimal configuration:

- **Issuer URL** — derived from `req.hostname` + `req.protocol` (Express's `trust proxy 1` setting honors Railway's `X-Forwarded-Proto` / `X-Forwarded-Host`). Setting `MINSKY_OAUTH_ISSUER` is only necessary if the service runs behind multiple hostnames.
- **Signing key** — `MINSKY_OAUTH_SIGNING_KEY` is set as a sealed Railway secret containing a persistent RSA-2048 JWK (kty=RSA, use=sig, alg=RS256). Tokens survive Railway redeploys. The env var is registered in `environmentMappings` (path `oauth.signingKey`) so the config system maps it correctly — the auto-conversion fallback would produce the wrong path (`oauth.signing.key`). See "Signing-key rotation" below for generation and rotation instructions.

### Onboarding claude.ai web users

1. The user opens claude.ai → Settings → Custom integrations → Add MCP server.
2. They enter `https://minsky-mcp-production.up.railway.app/mcp` as the server URL.
3. claude.ai fetches `/.well-known/oauth-protected-resource`, sees the OAuth requirement, and initiates the flow.
4. claude.ai performs Dynamic Client Registration (`POST /register`) per RFC 7591 — receives a `client_id` + `client_secret`.
5. claude.ai redirects the user to `/oauth/authorize?response_type=code&client_id=...&code_challenge=...&code_challenge_method=S256&resource=https://minsky-mcp-production.up.railway.app/mcp&redirect_uri=...`.
6. The browser sees the consent screen rendered by `oidc-provider`'s built-in interaction UI (mt#1683 will replace this with a Minsky-branded template).
7. After consent: `oidc-provider` issues an authorization code; claude.ai exchanges it at `/oauth/token` for an access + refresh token pair.
8. claude.ai sends `Authorization: Bearer <access_token>` on subsequent `/mcp` requests; the token-validation middleware accepts it and injects `agentId: oauth:claude-ai:user-<sub>` into the MCP request context.

### Coexistence with the static-bearer-token path

The local Claude Code daemon and CI scripts continue to authenticate via `Authorization: Bearer ${MINSKY_MCP_AUTH_TOKEN}` exactly as before. The token-validation middleware tries the static-bearer match first (short-circuits when configured), then falls through to OAuth validation when the OAuth provider is wired. Setting both `MINSKY_MCP_AUTH_TOKEN` and the OAuth provider is fine; either path can authenticate.

When `MINSKY_MCP_AUTH_TOKEN` is unset and the OAuth provider IS wired (Postgres available), `/mcp` enforces OAuth-only auth — fixed in mt#1666 R1 after the auto-reviewer-bot caught the original gating bug.

### Signing-key rotation

To rotate the signing key in production:

1. Generate a new RSA JWK (kty=RSA, use=sig, alg=RS256). The value MUST be a JWK JSON object as a string — NOT a raw hex secret. Example generator: `node -e 'const jose = require("jose"); jose.generateKeyPair("RS256").then(async ({privateKey}) => console.log(JSON.stringify(await jose.exportJWK(privateKey))))'`.
2. Set `MINSKY_OAUTH_SIGNING_KEY` via Pulumi: `cd infra && PULUMI_CONFIG_PASSPHRASE="" pulumi config set --secret secrets:minsky-oauth-signing-key '<new-jwk-json>'`
3. Apply via `PULUMI_CONFIG_PASSPHRASE="" pulumi up --refresh`.
4. Trigger redeploy. All issued access tokens become invalid immediately; clients re-authorize.

For zero-downtime rotation (multiple keys advertised in JWKS during a transition window): `oidc-provider` supports an array of signing keys via `jwks.keys` config — staging a new key while the old one is still advertised lets clients pick up the new key before the old is removed. Wiring this through `InProcessOAuthProvider` is out of scope for v1; tracked as a follow-up.

## Continuous monitoring

Post-deploy outcome and health verification for all deployed services runs automatically
every 10 minutes via a scheduled GitHub Action:

**Workflow:** `.github/workflows/post-deploy-health-monitor.yml`

**What is checked (per service with a provisioned serviceId):**

- **Deploy terminal status** via Railway GraphQL API — alerts on `FAILED` or `CRASHED`.
  Catches build failures (e.g. `bun install --frozen-lockfile` in Dockerfile).
- **HTTP health endpoint** — alerts when `GET <service>/health` (or `/api/health`
  for cockpit) returns non-200 or times out (10s threshold). Catches the
  runtime-crash-after-green-build class (mt#2345).
- **Service identity** (mt#3148) — asserts the health body's `service` field
  matches the service being probed. Catches the wrong-application-deployed class
  (mt#3142), which a status-code check structurally cannot see.

### A bare-200 healthcheck is insufficient in this monorepo (mt#3148)

Every deployed Minsky service is built from the **same repository**, so a
misconfigured build can put a _different_ application on a service's host — and
that application answers `GET /health` with `200 {"status":"ok"}` just as
convincingly as the right one.

This is not hypothetical. During mt#3142 the Minsky MCP server was deployed onto
the reviewer's Railway host and served `/health` 200 for roughly an hour while
every reviewer route 404'd. Railway's healthcheck reads the status code only, so
**the one signal wired to alerting was the one signal that could not detect the
fault.** The outage was found because a human noticed reviews weren't arriving.

The rule this yields: **a verification probe must be able to fail.** Before
treating a probe's output as evidence, establish that the broken state would
produce a _different_ output. A probe whose output space does not separate the
states you care about carries zero information — and is worse than no probe,
because nobody investigates a green check.

Concretely, every Minsky service emits a `service` field in its health body:

| Service    | Health path   | `service` value   |
| ---------- | ------------- | ----------------- |
| cockpit    | `/api/health` | `minsky-cockpit`  |
| minsky-mcp | `/health`     | `minsky-mcp`      |
| minsky-ops | `/health`     | `minsky-ops`      |
| reviewer   | `/health`     | `minsky-reviewer` |
| site       | `/health`     | `minsky-site`     |

`minsky-ops` used to be listed here as having "no application source and
therefore no health endpoint." That has been false since 2026-07-29 (mt#2132),
which gave it `source.image` and a start command; it answers `/health` 200 with
`"service": "minsky-ops"` plus a per-loop status array (read live 2026-08-11).
mt#3921 corrected three other copies of the same stale claim; mt#3933 found
these. The identity assertion matters MORE for this service than for the
others, not less: it runs the SAME `ghcr.io/edobry/minsky:latest` image as
minsky-mcp and differs only by a start-command override held in dashboard-only
state (mt#3848). If that override is ever lost it boots a second MCP server and
answers 200 from the wrong application — the mt#3142 failure mode, with both
candidate identities baked into one image.

`minsky-mcp` **also** retains its pre-existing `server: "Minsky MCP Server"`
key. That key is what mt#3142's own diagnosis read to identify the wrong app,
so it was kept unchanged and `service` added alongside it — the assertion is
additive, never a rename.

Assert identity with `assertServiceIdentity()` from
`packages/domain/src/deployment/health-identity.ts` rather than hand-rolling a
string compare; it distinguishes _wrong application_ (a hard failure — the
mt#3142 class) from _no identity field_ (weaker: the service may simply predate
this contract).

**`/health` persistence-liveness semantics (mt#2949):**

`GET /health` on `minsky-mcp` is not a static "process is up" check — it reflects
persistence liveness, distinguishing two very different reasons the process might
not have a working Postgres connection:

| Status | `persistence.mode` | Meaning                                                                                                                                                                                                                                                                                                                         |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | `"connected"`      | Postgres is configured and reachable.                                                                                                                                                                                                                                                                                           |
| `200`  | `"unconfigured"`   | No Postgres connection is configured anywhere (no `persistence.postgres.connectionString`, no `MINSKY_POSTGRES_URL`). Deliberate — the expected local/dev/offline boot path (mt#2349), and the exact state the `bundle-boot-smoke` CI gate boots in (fresh runner, no config file, no env override). Degraded but not an error. |
| `503`  | `"unavailable"`    | A Postgres connection string WAS configured, but initialization failed at boot (migration error, unreachable DB, bad credentials). A genuine outage.                                                                                                                                                                            |

Response body carries a `persistence` object with `mode` and (when not `"connected"`) a
human-readable `reason` string, e.g.:

```json
{
  "status": "unhealthy",
  "persistence": {
    "mode": "unavailable",
    "reason": "Postgres connection is configured but persistence failed to initialize (connect ECONNREFUSED ...) — see boot logs for the underlying error. This is NOT the expected local/dev degraded mode."
  }
}
```

**Why this matters:** during the 2026-07-19 outage, `/health` stayed a static `200`
regardless of persistence state, so this section's post-deploy-health-monitor (and
Railway's own deploy-health gate) reported the service healthy while every DB-backed
tool was dead for ~5 hours. The `503` case above is exactly the signal that class of
outage now produces. See `packages/domain/src/persistence/health.ts`
(`assessPersistenceHealth`) for the decision logic.

**Service discovery (mt#1302):**

The monitor discovers services at runtime by enumerating `services/*/deploy.config.ts`
and importing each config file. The service list, Railway `serviceId`s, and health URLs
are all read from those config files — nothing is hardcoded in the monitor script.

- **A service is skipped when its `railway.serviceId` is empty** (the standard
  "not yet provisioned" convention). This is exclusion by data, not by name.
- **Health URLs** are declared in the `healthUrl` field of each `DeploymentConfig`
  (see `packages/shared/src/deployment/config.ts`). To add or change a health URL,
  update the service's `deploy.config.ts` — no changes to the monitor script are needed.

To add a new service to the monitor: create `services/<name>/deploy.config.ts` with a
non-empty `railway.serviceId` and set the `healthUrl` field. The monitor picks it up
automatically on the next run.

**Current monitored services** (from `services/*/deploy.config.ts`):

| Service      | `railway.serviceId` (provisioned?) | `healthUrl`                                                        |
| ------------ | ---------------------------------- | ------------------------------------------------------------------ |
| `minsky-mcp` | yes                                | `https://minsky-mcp-production.up.railway.app/health`              |
| `reviewer`   | yes                                | `https://minsky-reviewer-webhook-production.up.railway.app/health` |
| `cockpit`    | yes                                | `https://cockpit-preview-production.up.railway.app/api/health`     |
| `site`       | yes                                | `https://minsky-site-production.up.railway.app/health`             |
| `minsky-ops` | yes (`f6e3f285-…`, since mt#2132)  | `https://minsky-ops-production.up.railway.app/health`              |

**Alerts:**

1. **Primary (infra-independent):** a GitHub P0 issue is opened (or updated if already
   open) per service+failure-class. De-duplicated so a sustained outage produces one
   issue, not N. Issues are labelled `p0-outage` and `post-deploy-monitor`.

   - **Resolution is automatic (mt#3963).** Once a run observes the failure class
     RECOVERED — the check that detects it RAN and found no problem — the monitor
     stamps a `P0_RECOVERY_FIRST_OBSERVED_AT` marker in the issue body; once that
     recovery has held for 8 minutes (mirroring the escalation side's sustained
     threshold, so an issue cannot flap open/closed across a rolling deploy) it
     comments with the run that observed the recovery and closes the issue. A
     check that could not RUN is not a recovery: an unrunnable check leaves the
     P0 open, exactly as it raises one (mt#3921).

     This bullet used to read "or let it auto-resolve (close the issue once the
     service is confirmed healthy)," which described behavior that did not
     exist — nothing closed an escalated P0. Four were open when mt#3963
     shipped, the oldest for 54 days, every one for a condition the same monitor
     run reported OK.

   - To mute during a planned redeploy: close the issue manually. A manually
     closed issue is not reopened; the monitor opens a NEW issue if the
     condition is still there on a later run.

   - Only issues this monitor opened are auto-closed — the resolver requires
     both labels AND the `Auto-opened by [post-deploy-health-monitor]` signature
     in the body, so a hand-filed `p0-outage` issue is never touched.

   - **Retitling a P0 is safe.** Identity comes from a `P0_SUBJECT: <service>|<class>`
     marker in the body, so adding context to the title mid-incident does not
     strand the issue open. Issues opened before that marker existed are matched
     on their canonical title as a substring, which tolerates an added prefix or
     suffix. Do not hand-edit either marker line.

2. **Secondary (best-effort):** when `MINSKY_MCP_AUTH_TOKEN` is set and the MCP service
   is reachable, a `coordination.notify` ask is created over hosted MCP so it surfaces
   on the cockpit AsksPage. Failure of this path never suppresses the primary alert.

**Required secrets (set as repository secrets):**

- `RAILWAY_TOKEN` — Railway API token with read access to the project's services.
- `MINSKY_MCP_AUTH_TOKEN` — Bearer token for the hosted MCP (secondary path).

**Dashboard:** https://github.com/edobry/minsky/actions/workflows/post-deploy-health-monitor.yml

**Manual retrigger:**

```bash
gh workflow run post-deploy-health-monitor.yml
```

**Dry run (logs findings without opening issues):**

```bash
gh workflow run post-deploy-health-monitor.yml -f dry_run=true
```

**Local smoke test:**

```bash
# Health-only (no Railway token required):
bun scripts/smoke-post-deploy-health-monitor.ts

# Full run with Railway deploy-status checks:
RAILWAY_TOKEN=... bun scripts/smoke-post-deploy-health-monitor.ts
```

## Verify deployment

Run the automated verify phase:

```bash
bun scripts/deploy-minsky-mcp.ts --phase=verify
```

All four probes must pass for a healthy deployment. Expected output:

```
  Probing https://<service>.up.railway.app
  ✓ GET /health → 200  (status=200)
  ✓ POST /mcp (no auth) → 401  (status=401)
  ✓ POST /mcp (auth, non-initialize) → 400 JSON-RPC -32600  (status=400, jsonrpc=2.0, error.code=-32600)
  ✓ POST /mcp initialize → 200 + mcp-session-id  (status=200, mcp-session-id present (36 chars))
  ✓ POST /mcp tools/list (with session id) → well-known tool  (status=200, well-known Minsky tool found in response (NNNN bytes))

All probes passed.
```

### Probe 1 — GET /health → 200

**What it proves:** The container is running and the health endpoint is reachable.

**Expected:** `status=200`

**Failure hints:**

- Non-200: container failed to start. Check `railway logs` for startup errors (missing env vars, failed Postgres connection).

### Probe 2 — POST /mcp (no auth) → 401

**What it proves:** The auth middleware is active and correctly rejects unauthenticated requests before they reach MCP logic.

**Expected:** `status=401`

**Failure hints:**

- Non-401: auth middleware is misconfigured or `--require-auth` flag was removed from `CMD`. Verify the Dockerfile CMD still passes `--require-auth`.

### Probe 3 — POST /mcp (auth, non-initialize) → 400 JSON-RPC -32600

**What it proves:** After the mt#1199 per-session Server fix, a valid-auth but protocol-invalid request (no `mcp-session-id`, non-initialize method) is rejected with a well-formed JSON-RPC error at the protocol level rather than a 500. mt#1199's `isInitializeRequest` gate emits a JSON-RPC `-32600 "Invalid Request"` error (with a message describing the missing initialize) before the SDK transport's own session validator (which would emit -32000) is reached.

**Expected (structural):** `status=400`, body is JSON-RPC 2.0 with `error.code === -32600` and `error.message` starting with `"Invalid Request"`. The exact message text and `id` field may evolve with future MCP SDK versions; the probe asserts the structural shape rather than an exact string. Current observed payload (informational, not contractual): `{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request: first request must be initialize"},"id":null}`.

**Failure hints:**

- `HTTP 500`: pre-fix regression — the "Already connected to a transport" bug from before mt#1199. Redeploy with the per-session Server fix.
- `HTTP 401`: auth gate broken; bearer token mismatch. Check `MINSKY_MCP_AUTH_TOKEN` matches on both client and Railway.
- `HTTP 4xx` (other than 400): protocol shape drift — unexpected response format.
- Non-JSON body: wrong server responding (Railway edge HTML error page). Check domain and Railway routing.
- Railway fallback active: container dead or cold-starting. Try again in 30 seconds.

### Probe 4 — Full initialize dance

Two sub-checks, both must pass:

**4a — POST /mcp initialize → 200 + mcp-session-id**

**What it proves:** The MCP initialize handshake succeeds end-to-end: auth passes, the per-session Server is created, and the `mcp-session-id` response header is set correctly.

**Expected:** `status=200`, `mcp-session-id` header present in response.

**Failure hints:**

- Status not 200: container unhealthy or auth token wrong.
- Missing `mcp-session-id` header: server not implementing StreamableHTTP session management correctly. Check `src/commands/mcp/start-command.ts`.
- Timeout after 30s: container hanging during tool registration cold start. Check `railway logs`.

**4b — POST /mcp tools/list (with session id) → well-known tool**

**What it proves:** The session established by initialize is usable for follow-up requests, and the full tool registry (including well-known Minsky tools like `session.get` or `tasks.list` — the dot-separated form used by the Minsky tool registry) is registered and returned.

**Expected:** `status=200`, response body contains `"session.get"` or `"tasks.list"`.

**Failure hints:**

- Status not 200: session expired or routing sent this request to a different container instance than initialize. Ensure Railway sticky sessions or that the server is single-instance.
- Well-known tool not in body: tool registration failed on startup. Check `railway logs` for adapter initialization errors.

### Manual verification with curl

```bash
# Health (public, expect 200)
curl https://<railway-domain>/health
# → {"status":"ok","server":"Minsky MCP Server","transport":"http","timestamp":"..."}

# Unauthenticated (expect 401)
curl -sS -o /dev/null -w "%{http_code}\n" https://<railway-domain>/mcp \
  -X POST -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# → 401

# Non-initialize authenticated (expect 400 + JSON-RPC -32600, after mt#1199)
curl -sS https://<railway-domain>/mcp \
  -H "Authorization: Bearer $MINSKY_MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# → {"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request: first request must be initialize"},"id":null}

# Initialize handshake (expect 200 + mcp-session-id header)
curl -sS -D - https://<railway-domain>/mcp \
  -H "Authorization: Bearer $MINSKY_MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-verify","version":"1.0.0"}}}'
# → HTTP 200 with mcp-session-id: <session-id>

# tools/list with session id (expect 200 + tool names)
curl -sS https://<railway-domain>/mcp \
  -H "Authorization: Bearer $MINSKY_MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: <session-id-from-above>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
# → response body contains "session.get" and "tasks.list"
```

## Consumer integration

Clients use MCP's HTTP transport (Streamable HTTP), passing the bearer token in the `Authorization` header. The `minsky-reviewer` service (mt#1085) is the reference consumer — see `services/reviewer/src/` for the client-side pattern once that task lands.

Minimum env the client needs:

```
MINSKY_MCP_URL=https://<railway-domain>/mcp
MINSKY_MCP_AUTH_TOKEN=<bearer-token-from-server>
```

The client and server both use the name `MINSKY_MCP_AUTH_TOKEN`.

## Troubleshooting

**Service boots but MCP calls 401:** `MINSKY_MCP_AUTH_TOKEN` mismatch between server and client. Confirm both have the identical value.

**Service refuses to start with "--require-auth passed but MINSKY_MCP_AUTH_TOKEN env var is not set":** set the env var OR remove `--require-auth` from `CMD`. Running in the "auth-enabled-but-no-token" undefined state is blocked intentionally.

**Health endpoint returns but /mcp returns 500:** container is up but MCP initialization failed. Check `railway logs` for the real error (often a missing `MINSKY_PERSISTENCE_POSTGRES_URL` or unavailable Postgres).

**MCP calls return `Tool execution failed: no such table: ...`:** historically this meant the container had silently fallen back to a SQLite default instead of Postgres (mt#1224). SQLite has since been removed entirely (mt#2339) — `PersistenceProviderFactory` now has exactly one backend case (`postgres`) and throws a clear "PostgreSQL configuration required" error instead of silently falling back. If you see this exact error today, check `MINSKY_PERSISTENCE_BACKEND=postgres` is set and the connection string resolves to a schema that has had `persistence migrate --execute` run against it — the silent-fallback failure mode itself is no longer reachable.

**Intermittent empty responses on tool calls:** session state issues with the Streamable HTTP transport. Check that the client is sending `mcp-session-id` correctly on follow-up requests after the initial session-establishment call.

**Auto-deploy not firing on main pushes:** verify the deployment trigger exists via GraphQL `service.repoTriggers` query (see `services/reviewer/DEPLOY.md` for the exact query). Also confirm the Railway GitHub App still has access to `edobry/minsky` at <https://github.com/settings/installations>.

## Why HTTP transport

This is the network primitive the rest of the agentic-infrastructure roadmap depends on. Reviewer tier lookup (mt#1085) is the first consumer; future ones include:

- **mt#216** — core agent loop for non-Claude-Code harnesses (needs network Minsky)
- **mt#1079** — mesh signal propagation (can graduate from CLAUDE.md stopgap to HTTP-based signals)
- **Hosted Minsky service** for external users (per the Identity & Provenance position paper)
- **IDE integrations** that don't bundle Minsky locally
- **Webhook-driven integrations** following the reviewer pattern

See mt#1129 for the scope boundary between this (transport + deploy + auth) and those downstream tasks (which own their own consumer-side wiring).

## Deployment-platform MCP tools

Agents observe Railway deploys via the platform-neutral MCP tools `deployment_wait-for-latest`,
`deployment_status`, and `deployment_logs`. These wrap the same Railway GraphQL primitives
used by `src/domain/deployment/railway/graphql-client.ts` and exposed through the agent-facing surface.
The platform-agnostic abstraction (adapter interface, registry, configuration shape) lives in
[`docs/deployment-platforms.md`](./deployment-platforms.md); this section covers Railway-specific
details only.

**Service declaration.** Each Railway service declares its deployment target in
`services/<svc>/deploy.config.ts` (see the platform-agnostic doc for the schema). For Railway
services the file declares project/environment/service IDs inline (previously imported from the now-retired `railway.config.ts`; canonical IaC source is `infra/index.ts`)
env-var manifest, avoiding duplication.

**Underlying calls.** The Railway adapter uses the same GraphQL endpoint and auth pattern as
the existing scripts: `https://backboard.railway.com/graphql/v2` with bearer token from
`~/.railway/config.json`. No fresh shell-out to the `railway` CLI is introduced. The
`waitForLatestDeployment` operation polls the `SERVICE_DEPLOYMENTS_QUERY` until the latest
deployment's status is in the terminal set (`SUCCESS / FAILED / CRASHED / CANCELLED / REMOVED / ERROR`).

**Default cadence.** 10-second poll interval, 10-minute timeout. Tune via the tool's
`timeoutSeconds` argument when calling.

## Auth notes

This is v1 authentication:

- Single shared-secret bearer token per environment
- No rotation, no per-agent identity, no audit trail
- Adequate while consumer count ≤ 3 and all consumers live in trusted infrastructure (Railway project, CI)

Follow-up when those bounds are exceeded: JWT issuance from Minsky, per-agent claims, rotation protocol, audit log. File as a separate task when the situation demands it.
