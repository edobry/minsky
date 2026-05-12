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
5. **Supabase Postgres URL**: the same connection string Minsky uses locally. Copy from `~/.config/minsky/config.yaml` (the `persistence.postgres.connectionString` field) or your local env.

## First deploy

```bash
cd /path/to/minsky
railway login
railway init --name minsky-mcp
railway up --detach -m "Initial deploy"
```

Railway auto-detects the `Dockerfile` at repo root and builds from it.

## Managing environment variables (canonical path)

**Use the TypeScript synthesizer (`scripts/railway/apply.ts`), not `railway variables --set`.**

All production env-var state for `minsky-mcp` is captured in `services/minsky-mcp/railway.config.ts`. Changes go through that file and are applied via the synthesizer. Direct `railway variables --set` calls are error-prone (no audit trail, no idempotency, values can drift silently) and should not be used for ongoing management.

### Synthesizer workflow

```bash
# Preview changes (dry-run — default)
bun scripts/railway/apply.ts services/minsky-mcp

# Apply changes (adds/updates only — deletions shown as WOULD-PRUNE, not applied)
bun scripts/railway/apply.ts services/minsky-mcp --execute

# Apply changes AND delete variables not in config (destructive — see --prune below)
bun scripts/railway/apply.ts services/minsky-mcp --execute --prune
```

The synthesizer:

1. Reads `services/minsky-mcp/railway.config.ts` (desired state)
2. Fetches current Railway variables via GraphQL (actual state)
3. Computes a typed diff and prints it
4. On `--execute`: applies ADD/CHANGE-VALUE/CHANGE-SEALED-FLAG entries via `railway environment edit --json` and reads back to confirm
5. On `--execute --prune`: also deletes REMOVE entries (variables present in Railway but absent from config)

### Deletion policy (--prune)

By default, `--execute` only applies ADD/CHANGE-VALUE/CHANGE-SEALED-FLAG entries. Variables present in Railway but absent from `railway.config.ts` are shown in dry-run output as `WOULD-PRUNE` but are **not deleted**. This protects Railway-injected variables (`RAILWAY_*` auto-vars) and any operator-set out-of-band variables from silent deletion.

To delete variables not declared in config, pass `--prune` explicitly:

```bash
# Dry-run: see what would be deleted (WOULD-PRUNE lines)
bun scripts/railway/apply.ts services/minsky-mcp

# Apply deletions too
bun scripts/railway/apply.ts services/minsky-mcp --execute --prune
```

When to use `--prune`:

- Removing a variable that was previously in config and you want it gone from Railway
- Cleaning up test variables applied manually during debugging
- First verified that every WOULD-PRUNE entry is intentionally out-of-spec

Do NOT use `--prune` if WOULD-PRUNE shows `RAILWAY_*` auto-injected variables — those are managed by Railway and will reappear after the next deploy.

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
  "MINSKY_PERSISTENCE_POSTGRES_URL": "<supabase-url>",
  "MINSKY_POSTGRES_URL": "<supabase-url>",
  "MINSKY_SESSIONDB_POSTGRES_URL": "<supabase-url>",
  "OPENAI_API_KEY": "<key>"
}
```

Secret vars are applied with `isSealed: true` on Railway — after sealing, the Railway dashboard and CLI hide the value (write-only). The synthesizer handles idempotency: if a var is already sealed on Railway, it classifies as NO-CHANGE without comparing values (sealed vars return `null` from the GraphQL API).

### Initial setup (one-time only)

For a brand-new Railway service with no variables set, the legacy `railway variables --set` form is acceptable for initial bootstrap:

```bash
# Auth — REQUIRED when using the --require-auth flag (which the default Dockerfile CMD enables)
railway variables --set MINSKY_MCP_AUTH_TOKEN=<output-of-openssl-rand-hex-32>

# Persistence — BOTH vars required.
railway variables --set MINSKY_PERSISTENCE_BACKEND=postgres
railway variables --set MINSKY_PERSISTENCE_POSTGRES_URL=<your-supabase-postgres-url>
```

After initial bootstrap, switch to the synthesizer: run a dry-run to verify the config file matches production state, then use `--execute` for all subsequent changes.

> **Why two vars:** the persistence layer reads `persistence.backend` (the backend selector) and `persistence.postgres.connectionString` (the URL) as separate fields. The legacy single-var shortcut (`MINSKY_POSTGRES_URL` — populating only the connection string) does not change the backend selector, so the service silently falls back to its SQLite default and every schema-dependent MCP call fails with `no such table: ...`. See mt#1224.
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

## OAuth runbook (mt#1634, shipped May 2026)

The hosted Minsky MCP supports OAuth 2.1 in addition to the static-bearer-token path. claude.ai web requires the OAuth flow as a precondition for adding remote MCP servers; mt#1634 shipped the full discovery + DCR + PKCE + RFC 8707 audience-binding flow backed by `oidc-provider`.

### Required env vars (none new for v1)

The InProcessOAuthProvider works with zero additional configuration in v1:

- **Issuer URL** — derived from `req.hostname` + `req.protocol` (Express's `trust proxy 1` setting honors Railway's `X-Forwarded-Proto` / `X-Forwarded-Host`). Setting `MINSKY_OAUTH_ISSUER` is only necessary if the service runs behind multiple hostnames.
- **Signing key** — when `MINSKY_OAUTH_SIGNING_KEY` is unset, the provider generates an ephemeral RSA-2048 keypair at startup and logs a WARN. **Tradeoff:** tokens are invalidated on every Railway redeploy. For v1 (claude.ai web acceptance) this is acceptable — users re-authorize when their token becomes invalid. Production hardening tracked separately.

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
2. Set `MINSKY_OAUTH_SIGNING_KEY` to the new JWK JSON via the synthesizer (`services/minsky-mcp/railway.config.ts`).
3. Apply via `bun scripts/railway/apply.ts services/minsky-mcp --execute`.
4. Trigger redeploy. All issued access tokens become invalid immediately; clients re-authorize.

For zero-downtime rotation (multiple keys advertised in JWKS during a transition window): `oidc-provider` supports an array of signing keys via `jwks.keys` config — staging a new key while the old one is still advertised lets clients pick up the new key before the old is removed. Wiring this through `InProcessOAuthProvider` is out of scope for v1; tracked as a follow-up.

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
MINSKY_MCP_TOKEN=<same-token-as-MINSKY_MCP_AUTH_TOKEN>
```

## Troubleshooting

**Service boots but MCP calls 401:** `MINSKY_MCP_AUTH_TOKEN` mismatch between server and client. Confirm both have the identical value.

**Service refuses to start with "--require-auth passed but MINSKY_MCP_AUTH_TOKEN env var is not set":** set the env var OR remove `--require-auth` from `CMD`. Running in the "auth-enabled-but-no-token" undefined state is blocked intentionally.

**Health endpoint returns but /mcp returns 500:** container is up but MCP initialization failed. Check `railway logs` for the real error (often a missing `MINSKY_PERSISTENCE_POSTGRES_URL` or unavailable Postgres).

**MCP calls return `Tool execution failed: no such table: ...`:** the container is running against its SQLite default instead of Postgres. Confirm `MINSKY_PERSISTENCE_BACKEND=postgres` is set (not just the connection-string var). See mt#1224.

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
used by `scripts/railway/{status,logs}.ts` but expose them through the agent-facing surface.
The platform-agnostic abstraction (adapter interface, registry, configuration shape) lives in
[`docs/deployment-platforms.md`](./deployment-platforms.md); this section covers Railway-specific
details only.

**Service declaration.** Each Railway service declares its deployment target in
`services/<svc>/deploy.config.ts` (see the platform-agnostic doc for the schema). For Railway
services the file imports project/environment/service IDs from the existing `railway.config.ts`
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
