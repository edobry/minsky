# Deploying minsky-reviewer to Railway

Stateless Node service. Railway is the documented default because webhooks are first-class and the AI-SaaS template matches the shape closely. Any Node-compatible host works — the service is stateless beyond its environment variables.

## Prerequisites (one-time, user action)

1. **Railway CLI** installed locally (`bash <(curl -fsSL cli.new)` or `brew install railway`).
2. **Railway account** with a workspace you can deploy under.
3. **`minsky-reviewer` GitHub App** created (mirror the setup from `docs/github-app-bot-setup.md` with the permissions listed in `README.md`).
4. **Webhook secret** generated: `openssl rand -hex 32`.
5. **Model-provider API key** for whichever provider you chose:
   - OpenAI (`OPENAI_API_KEY`) — default, GPT-5
   - Google (`GOOGLE_AI_API_KEY`) — Gemini 2.5 Pro
   - Anthropic (`ANTHROPIC_API_KEY`) — fallback, captures only context-isolation benefit

## First deploy

From the repo root:

```bash
cd services/reviewer
railway login
railway init --name minsky-reviewer
railway up --detach -m "Initial deploy"
```

## Set environment variables

```bash
railway variable set MINSKY_REVIEWER_APP_ID=<numeric-app-id>
railway variable set MINSKY_REVIEWER_PRIVATE_KEY="$(cat ~/.config/minsky/minsky-reviewer.pem)"
railway variable set MINSKY_REVIEWER_INSTALLATION_ID=<numeric-install-id>
railway variable set MINSKY_REVIEWER_WEBHOOK_SECRET=<secret-from-openssl>

railway variable set REVIEWER_PROVIDER=openai
railway variable set OPENAI_API_KEY=<your-key>

railway variable set MINSKY_REVIEWER_TIER2_ENABLED=false
```

After setting variables, trigger a redeploy:

```bash
railway redeploy
```

## Generate a public URL

```bash
railway domain
```

Copy the generated `https://<service>.up.railway.app` URL.

## Register the webhook

In the `minsky-reviewer` App settings page on GitHub:

- **Webhook URL:** `https://<railway-domain>/webhook`
- **Content type:** `application/json`
- **Secret:** the value of `MINSKY_REVIEWER_WEBHOOK_SECRET`
- **SSL verification:** Enabled
- **Events subscribed to:** Pull requests

## Verify deployment

```bash
# Railway-side
railway logs --lines 50
# Look for: {"event":"server_started","port":3000,...}

# GitHub-side
curl https://<railway-domain>/health
# Expect: {"status":"ok","provider":"openai","model":"gpt-5",...}
```

## Smoke test

1. Open a test PR on a branch you can delete. Include `<!-- minsky:tier=3 -->` in the description to force the reviewer to run.
2. Observe Railway logs for a `review_result` event.
3. Check the PR — `minsky-reviewer[bot]` should have posted a review.

## Production deploy (auto-deploy from main)

> **Disclaimer:** behaviors documented below were observed during the 2026-04-22 deploy on Railway CLI 4.40.2. The CLI and GraphQL API surface can change between versions, and Railway does not publish a formal schema guarantee. Verify against `railway --version` and Railway's current docs before relying on specifics — especially CLI subcommand/flag names and mutation input fields.

Steady state: pushes to `main` that land in the watched branch cause Railway to start a build. Whether a rebuild actually runs for a given push (path-filtered vs branch-wide) depends on Railway's internal change-detection logic for the deployment trigger, which is not publicly specified. Plan for the conservative case — rebuilds may fire on any main push, not only those touching `services/reviewer/`.

This is configured as a Railway **deployment trigger** (GraphQL type `DeploymentTrigger`) linking the service to `edobry/minsky` branch `main`. The service-level `source.rootDirectory` tells Railway where in the repo to run the build from.

### Prerequisite: grant Railway access to the repo

Railway's GitHub App must have access to `edobry/minsky`. Without this, the trigger creation fails with _"no one in the project has access to it"_.

One-time grant:

1. Visit <https://github.com/apps/railway-app/installations/new>
2. Select the `edobry` account (or the org that owns `minsky`)
3. Either _All repositories_ or _Only select repositories_ → add `edobry/minsky`
4. Click _Install_ / _Save_

### Configure the deployment trigger

> **Critical ordering gotcha** — set `source.rootDirectory` on the service config via a JSON config merge BEFORE running the `deploymentTriggerCreate` mutation. Creating the trigger fires an immediate build against whatever `rootDirectory` is currently on the service; missing config → build runs from the repo root → wrong image gets deployed → service crashes. This cost ~20 minutes of reviewer-service downtime on 2026-04-22 when the ordering was reversed.
>
> Apply the rootDirectory merge first (note: this is a shallow document merge, not an RFC 6902 JSON Patch):
>
> ```bash
> cat <<'EOF' | railway environment edit --json
> {"services":{"<service-id>":{"source":{"rootDirectory":"services/reviewer","repo":"edobry/minsky","branch":"main"}}}}
> EOF
> ```
>
> Verify it persisted with `railway environment config --json` before proceeding. The CLI's dot-path `--service-config source.rootDirectory ...` form was observed to silently no-op for this field on CLI 4.40.2; the JSON-merge form worked. If that silent no-op is reproducible on your install, consider filing upstream against Railway.

> **Note:** the project/environment/service UUIDs below are for the live `edobry` Railway deployment. Replace them with your own from `railway status --json` for any other deployment.

Project ID: `41e5ee9c-49e6-44ff-9bfe-7f03d0e94d4b`
Environment ID (production): `b3ea3f5d-8560-40ea-8824-17fe3ca0b32a`
Service ID (minsky-reviewer-webhook): `3913e8a4-81ab-465a-aad8-b76b5e3f66ed`

GraphQL mutation against `https://backboard.railway.com/graphql/v2` with a Railway bearer token:

```graphql
mutation Create($input: DeploymentTriggerCreateInput!) {
  deploymentTriggerCreate(input: $input) {
    id
    branch
    repository
    provider
  }
}
```

Variables (note: `rootDirectory` is a **service-config** field, not a trigger field — set it via the JSON config merge above, not here):

```json
{
  "input": {
    "projectId": "41e5ee9c-49e6-44ff-9bfe-7f03d0e94d4b",
    "environmentId": "b3ea3f5d-8560-40ea-8824-17fe3ca0b32a",
    "serviceId": "3913e8a4-81ab-465a-aad8-b76b5e3f66ed",
    "branch": "main",
    "repository": "edobry/minsky",
    "provider": "github"
  }
}
```

The Railway CLI does not expose a first-class `trigger create` command at 4.40.x — the GraphQL path is the canonical option. Railway web UI also supports it (service settings → _Source_ → _Connect Repo_).

### What happens after a merge

1. GitHub sends a webhook to Railway when `main` moves.
2. Railway decides whether to run a build. Observed behavior on 2026-04-22: the service rebuilt even on main commits that didn't touch `services/reviewer/`, suggesting the deployment trigger is branch-wide rather than path-filtered. **Plan for this — do not assume path-filtered rebuilds.** If you need strict path filtering, configure `build.watchPatterns` separately on the service.
3. When Railway does build, it uses the Dockerfile at `services/reviewer/Dockerfile` (resolved from the `rootDirectory` in the service's `source` config) and deploys the new image to `production`.

Railway's _Deployments_ tab in the web UI and the `railway logs` CLI show each auto-triggered build. The build metadata includes `RAILWAY_GIT_COMMIT_SHA` so you can correlate back to the merge commit.

### Verify auto-deploy

```bash
# After merging a PR that touches services/reviewer/
railway deployment list --service minsky-reviewer-webhook --limit 5 --json
# Newest entry should be status=SUCCESS and reference the recent commit.
# JSON field names may vary by CLI version — run `railway deployment list --help`
# to see the schema for your install.

curl https://<railway-domain>/health
# Confirms the new code is serving traffic.
```

If no new deployment appears within ~60s of the merge, check:

- The GitHub App grant is live (`Installed` at <https://github.com/settings/installations>)
- The deployment trigger exists (query `service.repoTriggers` via GraphQL — exact field names subject to API version)
- The merge commit actually touched a file under `rootDirectory` (if you configured `build.watchPatterns`; otherwise every main push triggers)

### Manual deploy still works

`railway up --detach` remains available for out-of-band pushes (e.g. testing uncommitted code on the production service). Prefer merge-to-main for anything reviewed; use manual deploy only for transient testing.

## Troubleshooting

**Service boots but no webhooks arrive:** check the webhook URL in the App settings, check Railway domain is public, check the "Recent deliveries" in the App webhook settings page.

**Signature verification fails:** confirm the webhook secret is identical between Railway variables and the App webhook settings.

**Reviewer identity matches PR author:** you've configured the reviewer App ID to be the same as the implementer App. They must be distinct Apps.

**Review posts but uses Claude:** you've left `REVIEWER_PROVIDER=anthropic` which is the fallback path; switch to `openai` or `google` for real model diversity.
