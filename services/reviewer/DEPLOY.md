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

## Troubleshooting

**Service boots but no webhooks arrive:** check the webhook URL in the App settings, check Railway domain is public, check the "Recent deliveries" in the App webhook settings page.

**Signature verification fails:** confirm the webhook secret is identical between Railway variables and the App webhook settings.

**Reviewer identity matches PR author:** you've configured the reviewer App ID to be the same as the implementer App. They must be distinct Apps.

**Review posts but uses Claude:** you've left `REVIEWER_PROVIDER=anthropic` which is the fallback path; switch to `openai` or `google` for real model diversity.
