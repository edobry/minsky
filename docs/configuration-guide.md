# Minsky configuration guide

## Overview

Minsky's configuration system resolves storage backends, session databases, AI providers, and credentials through a strict precedence chain — CLI args → env vars → user config → repo config → defaults. Every value is validated at load; type errors and unknown keys fail loud at boot rather than silently at use. This guide walks the precedence order, the validation layer, the migration paths, and the operational defaults.

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
