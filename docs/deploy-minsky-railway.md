# Deploying Minsky MCP to Railway

Run Minsky's MCP server as a network-reachable HTTP service on Railway. External agents (the `minsky-reviewer` webhook service, future non-Claude-Code harnesses, mesh peers) can then query Minsky state over HTTP instead of requiring a local install.

This is the deployment guide for mt#1129. For the architectural context, see §"Why HTTP transport" below.

## Architecture in one paragraph

Minsky's MCP server is transport-agnostic — the same tool registry serves stdio (for local Claude Code) and HTTP (for remote agents). The CLI flag `--http` selects the HTTP transport; `--require-auth` enables a bearer-token check on the `/mcp` endpoint. Railway wraps all of this in a container and auto-deploys on `main`. The `/health` endpoint stays public for Railway's uptime probes.

## Prerequisites (one-time)

1. **Railway CLI**: `brew install railway` or `bash <(curl -fsSL cli.new)`.
2. **Railway account** with a workspace you can deploy under.
3. **GitHub App grant for Railway**: the Railway GitHub App must be installed on `edobry/minsky` (same grant as mt#1107). Verify at <https://github.com/settings/installations>.
4. **Auth token**: `openssl rand -hex 32` — this becomes `MINSKY_MCP_AUTH_TOKEN`. Distribute only to trusted service consumers.
5. **Supabase Postgres URL**: the same `DATABASE_URL` Minsky uses locally. Copy from `~/.config/minsky/config.yaml` or your env.

## First deploy

```bash
cd /path/to/minsky
railway login
railway init --name minsky-mcp
railway up --detach -m "Initial deploy"
```

Railway auto-detects the `Dockerfile` at repo root and builds from it.

## Set environment variables

```bash
# Auth — REQUIRED when using the --require-auth flag (which the default Dockerfile CMD enables)
railway variable set MINSKY_MCP_AUTH_TOKEN=<output-of-openssl-rand-hex-32>

# Database — the same Supabase instance used locally
railway variable set DATABASE_URL=<your-supabase-postgres-url>

# Any other Minsky config env vars your setup uses (GitHub tokens, OpenAI keys, etc.)
# The MCP server runs the same tools as the CLI, so it needs the same env.
```

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

## Verify deployment

### Unauthenticated health probe

```bash
curl https://<railway-domain>/health
# → {"status":"ok","server":"Minsky MCP Server","transport":"http","timestamp":"..."}
```

### Authenticated MCP probe

List all registered tools:

```bash
curl -sS https://<railway-domain>/mcp \
  -H "Authorization: Bearer $MINSKY_MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### Unauthorized request

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://<railway-domain>/mcp \
  -X POST -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# → 401
```

## Consumer integration

Clients use MCP's HTTP transport (Streamable HTTP), passing the bearer token in the `Authorization` header. The `minsky-reviewer` service (mt#1085) is the reference consumer — see `services/reviewer/src/` for the client-side pattern once that task lands.

Minimum env the client needs:

```
MINSKY_MCP_URL=https://<railway-domain>/mcp
MINSKY_MCP_TOKEN=<same-token-as-MINSKY_MCP_AUTH_TOKEN>
```

## Troubleshooting

**Service boots but MCP calls 401:** `MINSKY_MCP_AUTH_TOKEN` mismatch between server and client. Confirm both have the identical value.

**Service refuses to start with "--require-auth passed but MINSKY_MCP_AUTH_TOKEN env var is not set":** set the env var OR remove `--require-auth` from `CMD`. Running in the "auth-enabled-but-no-token" undefined state is blocked intentionally.

**Health endpoint returns but /mcp returns 500:** container is up but MCP initialization failed. Check `railway logs` for the real error (often a missing `DATABASE_URL` or unavailable Postgres).

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

## Auth notes

This is v1 authentication:

- Single shared-secret bearer token per environment
- No rotation, no per-agent identity, no audit trail
- Adequate while consumer count ≤ 3 and all consumers live in trusted infrastructure (Railway project, CI)

Follow-up when those bounds are exceeded: JWT issuance from Minsky, per-agent claims, rotation protocol, audit log. File as a separate task when the situation demands it.
