# Minsky configuration guide

## Overview

Minsky's configuration system resolves storage backends, session databases, AI providers, and credentials through a strict precedence chain — CLI args → env vars → user config → repo config → defaults. Every value is validated at load; type errors fail loud at boot. Unknown top-level keys are stripped and warned at ERROR level but do not crash the process (mt#2161) — this makes the config file resilient to multi-version writers (cockpit, CLI, MCP servers at different code versions). This guide walks the precedence order, the validation layer, the migration paths, and the operational defaults.

## Configuration Precedence Order

Minsky follows a strict configuration precedence order, where higher-priority sources override lower-priority ones:

### 1. Command Line Arguments (Highest Priority)

```bash
minsky tasks list --backend=github-issues
minsky session start --sessiondb-backend=sqlite
```

### 2. Environment Variables

```bash
export MINSKY_PERSISTENCE_BACKEND=postgres
export MINSKY_PERSISTENCE_POSTGRES_URL="postgresql://user:pass@localhost/minsky"
export MINSKY_AI_DEFAULT_PROVIDER=openai
export MINSKY_WORKSPACE_MAIN_PATH="/absolute/path/to/main/workspace"  # NEW
export MINSKY_SUPABASE_ACCESS_TOKEN="sbp_..."  # Supabase Management API PAT (see docs/supabase-alerts.md)
```

### 3. User Configuration File (`~/.config/minsky/config.yaml`)

```yaml
version: 1
workspace:
  mainPath: "/absolute/path/to/main/workspace" # NEW
persistence:
  backend: sqlite
  sqlite:
    dbPath: "~/.local/state/minsky/sessions.db"
```

### 4. Repository Configuration File (`.minsky/config.yaml`)

```yaml
version: 1
workspace:
  mainPath: "/absolute/path/to/main/workspace" # NEW
backends:
  default: "github-issues"
```

### 5. Default Configuration (Lowest Priority)

Built-in defaults ensure Minsky works out-of-the-box without any configuration.

## Workspace Configuration (NEW)

The `workspace` section allows specifying the absolute path to the main workspace root:

```yaml
workspace:
  mainPath: "/Users/you/Projects/minsky"
```

- When set, task backends that operate on the local workspace resolve `process/tasks.*` and task specs against `workspace.mainPath`.
- If unset, backends fall back to explicit `workspacePath` or `process.cwd()`.
- Environment override: `MINSKY_WORKSPACE_MAIN_PATH`.

## Notes

- This setting prevents accidental use of remote URLs or session workspace paths for task file operations.

## Embeddings Configuration

The `embeddings` section controls the embedding provider and optional fallback chain.

### Provider selection

```yaml
embeddings:
  provider: openai # Primary provider (default: "openai")
  model: text-embedding-3-small # Model name (default: "text-embedding-3-small")
  fallbackProvider: gemini # Fallback provider on quota exhaustion (optional)
```

Valid providers: `openai`, `gemini`, `local` (dev-only deterministic hash).

### Fallback chain

When `fallbackProvider` is set and the primary provider returns `insufficient_quota` or `RESOURCE_EXHAUSTED`, the system automatically routes to the fallback provider. Transient 429 rate limits are handled by the retry service and do not trigger fallback.

The fallback provider must produce embeddings with the same dimensions as the primary (1536 for `text-embedding-3-small`). Google `gemini-embedding-001` supports `output_dimensionality: 1536` via Matryoshka learning; other providers (Voyage, Cohere) do not support 1536 dimensions.

Fallback state is visible in `debug_systemInfo` under `embeddingsHealth.fallbackActive` and `embeddingsHealth.fallbackProvider`.

### Google AI API key

Required when `fallbackProvider: gemini` is set.

```yaml
ai:
  providers:
    google:
      apiKey: <your-google-ai-api-key>
```

Environment variable: `GOOGLE_API_KEY` or `GOOGLE_AI_API_KEY`.

Obtain a key at https://aistudio.google.com/apikey. Add via `minsky config credentials add google`.

## Postgres Persistence

For Postgres-specific runtime settings — connection pool size (`persistence.postgres.maxConnections`,
`MINSKY_POSTGRES_MAX_CONNECTIONS`), connection-exhaustion retry behavior, and MCP graceful shutdown —
see [Postgres Persistence Configuration](./persistence-configuration.md).

## Reviewer Configuration

The `reviewer.retrigger` command re-triggers a review on a PR's current HEAD by calling the
minsky-reviewer webhook service's `POST /retrigger` endpoint (mt#2269). As of mt#2346 it
authenticates with the **Minsky MCP auth token** (`mcp.auth.token` ← `MINSKY_MCP_AUTH_TOKEN`)
— the operator->service credential you already hold for the hosted Minsky MCP endpoint, which
the reviewer service also has — **not** the webhook HMAC secret. Operators therefore never
need to obtain or store the reviewer's webhook signing secret locally; that secret stays on
the reviewer service for GitHub->reviewer webhook signature verification only.

```yaml
mcp:
  auth:
    # Bearer token for the hosted Minsky MCP endpoint. Also used by
    # reviewer.retrigger to authenticate against the reviewer service.
    token: "<mcp-auth-token>"
reviewer:
  # Base URL of the reviewer webhook service. Optional; when unset, falls back to
  # the hosted production service (minsky-reviewer-webhook-production.up.railway.app).
  # Set this only to point at a non-default deployment.
  url: "https://minsky-reviewer-webhook-production.up.railway.app"
```

- `mcp.auth.token` — required to run `reviewer.retrigger`. When absent the command errors.
  Environment override: `MINSKY_MCP_AUTH_TOKEN` → `mcp.auth.token`.
- `reviewer.url` — optional; when unset, falls back to the hosted reviewer URL. Environment
  override: `MINSKY_REVIEWER_URL` → `reviewer.url`.
- `reviewer.webhookSecret` (`MINSKY_REVIEWER_WEBHOOK_SECRET`) — **deprecated for retrigger
  (mt#2346)**; no longer read by the command. The config key + env mapping are retained only
  so a lingering value still parses safely at boot. The reviewer service reads its webhook
  secret from its own loader, not this config path.
- Per the precedence order above, environment variables override the config-file values.

> Note: posting a `/review` comment on the PR is an alternative re-trigger path that does
> not require any token (the reviewer bot advertises it in its status comment).
