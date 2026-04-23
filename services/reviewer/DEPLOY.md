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

Steady state: **Railway rebuilds and redeploys the service automatically whenever a commit lands on `main` that touches `services/reviewer/`.** No manual `railway up` required.

This is configured as a Railway **deployment trigger** (GraphQL type `DeploymentTrigger`) linking the service to `edobry/minsky` branch `main` with `rootDirectory: /services/reviewer`.

### Prerequisite: grant Railway access to the repo

Railway's GitHub App must have access to `edobry/minsky`. Without this, the trigger creation fails with _"no one in the project has access to it"_.

One-time grant:

1. Visit <https://github.com/apps/railway-app/installations/new>
2. Select the `edobry` account (or the org that owns `minsky`)
3. Either _All repositories_ or _Only select repositories_ → add `edobry/minsky`
4. Click _Install_ / _Save_

### Configure the deployment trigger

> **Critical ordering gotcha** — set `source.rootDirectory` on the service config via JSON patch BEFORE running the `deploymentTriggerCreate` mutation. Creating the trigger fires an immediate build against whatever `rootDirectory` is currently on the service; missing config → build runs from the repo root → wrong image gets deployed → service crashes. This cost ~20 minutes of reviewer-service downtime on 2026-04-22 when the ordering was reversed.
>
> Apply the rootDirectory patch first:
>
> ```bash
> cat <<'EOF' | railway environment edit --json
> {"services":{"<service-id>":{"source":{"rootDirectory":"/services/reviewer","repo":"edobry/minsky","branch":"main"}}}}
> EOF
> ```
>
> Verify it persisted with `railway environment config --json` before proceeding. The CLI's dot-path `--service-config source.rootDirectory ...` form silently no-ops for this field; JSON-patch is the working form.

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

Variables:

```json
{
  "input": {
    "projectId": "41e5ee9c-49e6-44ff-9bfe-7f03d0e94d4b",
    "environmentId": "b3ea3f5d-8560-40ea-8824-17fe3ca0b32a",
    "serviceId": "3913e8a4-81ab-465a-aad8-b76b5e3f66ed",
    "branch": "main",
    "repository": "edobry/minsky",
    "provider": "github",
    "rootDirectory": "/services/reviewer"
  }
}
```

The Railway CLI does not expose a first-class `trigger create` command at 4.40.x — the GraphQL path is the canonical option. Railway web UI also supports it (service settings → _Source_ → _Connect Repo_).

### What happens after a merge

1. GitHub sends a webhook to Railway when `main` moves.
2. Railway checks whether any file under `rootDirectory` (`/services/reviewer`) changed.
3. If yes, Railway builds from the new SHA using the Dockerfile at `services/reviewer/Dockerfile` and deploys the new image to `production`.
4. If no, no rebuild is triggered.

Railway's _Deployments_ tab in the web UI and the `railway logs` CLI show each auto-triggered build. The build metadata includes `RAILWAY_GIT_COMMIT_SHA` so you can correlate back to the merge commit.

### Verify auto-deploy

```bash
# After merging a PR that touches services/reviewer/
railway deployment list --service minsky-reviewer-webhook --limit 5 --json
# Newest entry should have meta.commitSha matching the merge commit.

curl https://<railway-domain>/health
# Confirms the new code is serving traffic.
```

If no new deployment appears within ~60s of the merge, check:

- The GitHub App grant is live (`Installed` at <https://github.com/settings/installations>)
- The deployment trigger exists (query `service.repoTriggers` via GraphQL)
- The merge commit actually touched a file under `rootDirectory`

### Manual deploy still works

`railway up --detach` remains available for out-of-band pushes (e.g. testing uncommitted code on the production service). Prefer merge-to-main for anything reviewed; use manual deploy only for transient testing.

## Troubleshooting

**Service boots but no webhooks arrive:** check the webhook URL in the App settings, check Railway domain is public, check the "Recent deliveries" in the App webhook settings page.

**Signature verification fails:** confirm the webhook secret is identical between Railway variables and the App webhook settings.

**Reviewer identity matches PR author:** you've configured the reviewer App ID to be the same as the implementer App. They must be distinct Apps.

**Review posts but uses Claude:** you've left `REVIEWER_PROVIDER=anthropic` which is the fallback path; switch to `openai` or `google` for real model diversity.
