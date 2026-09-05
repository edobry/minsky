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
export MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT=2  # postgres-js connect_timeout, SECONDS (1-300; default 10). Hook-shelled minsky CLI calls inject 2 for fail-fast during slow-DB windows (mt#2982)
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

## Rule Selection (`rules`)

Which of Minsky's shipped rules this project uses. `minsky init` installs the base rules (not
declinable) plus the optional ones, and lists the optional set so you can turn any of them off.

```yaml
rules:
  presets: [] # named bundles, derived from rule tiers
  enabled: [] # rules turned on beyond the defaults
  disabled: # rules you have declined
    - json-parsing
  rung: T2 # optional: the project's adoption rung
```

Minsky does not own this block — `minsky init --overwrite` preserves your entries rather than
rewriting them. Manage it with the commands rather than by hand:

```bash
minsky rules config              # what is currently selected
minsky rules disable --id <id>   # decline a rule
minsky rules enable --id <id>    # re-enable one you declined
minsky compile                   # regenerate the harness outputs
```

`compile` is what actually adds or removes the rule from `.claude/rules/`, `.cursor/rules/` and
`AGENTS.md`; those are generated outputs and hand-edits to them are overwritten. A `disabled`
entry naming a base rule is refused, with the reason stated — base rules are the ones Minsky's own
workflows depend on.

For CI or scripted onboarding, decide at init time instead — it writes the same config:

```bash
minsky init --backend minsky --disable json-parsing,git-safety
```

Optional rules stay installed until you remove them, so a project nobody reviews keeps the full set.

## Task Backend Configuration

### `tasks.githubBackend.enabled` (default: `false`)

Controls whether the GitHub Issues task backend is registered at startup. The github backend
is **disabled by default** — the Minsky DB (`mt#`) backend is the operational default.

```yaml
tasks:
  githubBackend:
    enabled: false # default — github-issues backend disabled
```

**When `false` (default):**

- `tasks_create` with no explicit backend → Minsky (`mt#`) backend (unchanged)
- `minsky tasks list` → Minsky tasks only
- Explicit `--backend github` or `--backend github-issues` → throws:
  ```
  GitHub-issues task backend is disabled. Set tasks.githubBackend.enabled=true in your Minsky config to use it.
  ```
- Multi-backend registration silently skips the github backend with an info-level log

**When `true`:**

- GitHub backend registers alongside Minsky when GitHub credentials (`GITHUB_TOKEN`,
  owner, repo) are configured
- `gh#` prefixed tasks become accessible
- This restores the behavior from before the gate was introduced

See [GitHub Issues Backend Guide](./github-issues-backend-guide.md) for full setup
instructions and prerequisites.

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

## Credentials

Credentials live in `~/.config/minsky/config.yaml` at each provider's own `configPath`. Three entry
points write them, and which one you use depends on who is asking.

### A human adding a credential they already have

```bash
minsky config credentials add <provider>     # masked interactive prompt
```

Omit `--token` on the CLI to get the masked prompt. The cockpit's Settings → Credentials page is the
same operation with a form.

**Do not call `config.credentials.add` over MCP to acquire a credential.** Its `token` parameter
exists for the scripted path, so an agent passing a value there writes the secret into its own
tool-call input — which is the transcript. The masking is a CLI-only property.

### An agent that needs a credential it cannot read

```bash
minsky credentials request --provider <id> --reason "<why this is needed now>" \
  [--parent-task-id mt#NNNN]
```

Files a request the principal answers in a masked form on the ask itself. **The command has no
parameter capable of carrying a value**, and never returns one. The value travels
browser → cockpit server → `~/.config/minsky/config.yaml` and touches nothing else.

If no provider is registered for the id, the command refuses at call time and names
`packages/domain/src/credentials/providers/index.ts` — filing a request the principal has no way to
satisfy is the failure mode this avoids.

### Checking a filed request

```bash
minsky credentials request-status --request-id <id>
```

Returns one of:

| Status          | Meaning                                                           | What the agent should do                     |
| --------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| `pending`       | Still waiting on the principal                                    | Keep waiting                                 |
| `satisfied`     | The credential is present; carries the provider's validation line | Proceed                                      |
| `declined`      | The principal refused                                             | **Do not re-ask**                            |
| `unanswered`    | Cancelled or expired without an answer                            | Re-file if still needed                      |
| `policy-closed` | Auto-resolved by ask policy; the principal never saw it           | Escalate — no credential is coming (mt#3233) |

`declined` and `policy-closed` are deliberately distinct: one is a decision, the other is a request
that never reached a human. Treating the second as a refusal reports a choice the principal never made.

**Resolution is by credential PRESENCE**, not by anything the principal clicks. So satisfying the
request out-of-band — `minsky config credentials add <provider>` in a terminal, or having already set
it — closes the same request, with no second place to enter the value.

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

> **The `mcp` section is split across two files by scope (mt#4699).** The block above shows only
> the project-scoped half. `mcp.auth.token` is a credential for the hosted endpoint and is the same
> for everyone working on the project, so it belongs in `.minsky/config.yaml` (or user config).
> **`mcp.transport`, `mcp.port` and `mcp.host` are machine scope and live in the gitignored
> `.minsky/config.local.yaml`** — two developers on one repo can legitimately differ on them, and
> `minsky mcp start` does not read them at all (it derives its transport from CLI flags:
> `--http` / `--local-daemon`). Their only consumers are the local MCP-client registration path
> (`minsky setup`, `minsky mcp register`).
>
> `minsky init` writes the local half for you via `minsky setup`; hand-editing is not expected.
> Two caveats if you do: the config loader layers `config.local.yaml` over `config.yaml`, so a
> value set there IS what `getConfiguration()` resolves — but a later `minsky setup` run rewrites
> the file, so a hand-set transport does not survive one. A project initialized before mt#4699
> still has these keys in its committed `config.yaml`, and `setup` continues to honour them from
> there, so nothing needs migrating.

- `mcp.auth.token` — required for `reviewer.retrigger`'s direct endpoint path. Environment
  override: `MINSKY_MCP_AUTH_TOKEN` → `mcp.auth.token`.
- `reviewer.url` — optional; when unset, falls back to the hosted reviewer URL. Environment
  override: `MINSKY_REVIEWER_URL` → `reviewer.url`.
- **`minsky config doctor` surfaces a warning when `mcp.auth.token` is absent, and
  `minsky config doctor --fix` provisions it automatically** (mt#2660 detection; mt#2679
  turnkey fix). The fix reads `MINSKY_MCP_AUTH_TOKEN` from
  `~/.config/minsky/railway-secrets.json` (the deploy synthesizer's secret store, which
  already holds it on any machine set up for deploys) and writes `mcp.auth.token` through the
  standard config writer — no hand-editing, and the secret value is never printed. Long-lived
  processes cache config at boot (mt#1427), so reconnect the MCP server (`/mcp`) after fixing.
- **GitHub-auth fallback (mt#2679):** when `mcp.auth.token` is absent but `github.token` is
  configured, `reviewer.retrigger` does not error — it posts a `/review` comment on the PR via
  the GitHub credential (the reviewer service treats a first-line `/review` comment from an
  OWNER/MEMBER/COLLABORATOR author as a retrigger command, mt#2127). The result names the path
  used (`direct` vs `review-comment`); the fallback is asynchronous and applies to open PRs
  only. Only when BOTH credentials are absent does the command error, naming both remediation
  paths.
- `reviewer.webhookSecret` (`MINSKY_REVIEWER_WEBHOOK_SECRET`) — **deprecated for retrigger
  (mt#2346)**; no longer read by the command. The config key + env mapping are retained only
  so a lingering value still parses safely at boot. The reviewer service reads its webhook
  secret from its own loader, not this config path.
- Per the precedence order above, environment variables override the config-file values.

> Note: posting a `/review` comment on the PR is an alternative re-trigger path that does
> not require any token (the reviewer bot advertises it in its status comment).

### Service-side configuration lives with the service

Everything above is **operator→service** configuration: what you set locally to talk to the
reviewer. The reviewer service's own environment — `REVIEWER_PROVIDER`, `REVIEWER_MODEL`, the
network-call timeouts, the behavioural feature flags, and `REVIEWER_EXPERIMENT_MODEL` (the
per-PR model A/B, mt#4569) — is documented in **`services/reviewer/README.md`**, and is set on
the deployed service rather than in `~/.config/minsky/config.yaml`.

Deliberately a pointer and not a copy: none of those variables are listed here today, so
adding one would create a second, partial home for the set and leave a reader unable to tell
whether an absent variable is undocumented or nonexistent.

## Cockpit Configuration

The cockpit daemon binds to loopback (`127.0.0.1`) and enforces a Host-header allowlist as a
DNS-rebinding defense (mt#2538): only the standard loopback aliases and the `--host` bind value
(if you opted into one) are accepted by default. `cockpit.allowedHosts` (mt#3641) adds
operator-configured extra Host names ON TOP of that default — an allowlist ADDITION, never a
bypass — so the daemon can accept requests forwarded through `tailscale serve` under the node's
Tailscale MagicDNS name while staying bound to loopback (Tailscale's own recommended posture).

```yaml
cockpit:
  # TCP port the daemon serves on AND the port the menu-bar tray supervises.
  port: 4317

  # Extra Host-header names the daemon accepts, beyond the loopback aliases
  # and any --host bind value. Typically a Tailscale MagicDNS name.
  allowedHosts:
    - "my-node.tail1234.ts.net"
```

- `cockpit.port` (mt#3988) — optional, defaults to `3737`. Environment override:
  `MINSKY_COCKPIT_PORT`. An explicit `--port` on `cockpit start` / `status` / `install` outranks
  both.

  This is the **one** place the port is decided. The macOS tray reads this same value at startup
  (via `config get cockpit.port`, run against the tree it spawns the daemon from) and uses it for
  every probe, adoption decision, conflict label, the in-app webview URL, and the webview's
  same-origin navigation check. Before it, the tray hardcoded 3737 in four separate constants, so
  a daemon on any other port was invisible to it: not adopted, not controlled by
  Start/Stop/Restart, and liable to have a second daemon spawned beside it — which happened on
  2026-06-04, with the browser reading the stale one.

  **A tray already running does not pick up a change to this key**; it resolves once at launch.
  Quit and relaunch the tray after changing it. A tray whose Minsky checkout predates this key
  falls back to 3737 and logs that it did.

  **Do not set this to 80 or 443.** The tray's webview treats a navigation as same-origin only on
  an EXPLICIT port match, and a URL at a scheme's default port carries no explicit port — so at 80
  or 443 the check matches nothing and cockpit links open in the OS browser instead of in the app.
  Matching the implicit default instead would widen a security check to admit any portless
  `http://localhost/…`, so the tray deliberately fails closed here (PR #2882 R1). This is not a
  practical restriction: the daemon serves plain HTTP on loopback, and binding 80 needs root.

- `cockpit.allowedHosts` — optional, defaults to `[]` (no extra hosts; the pre-mt#3641
  loopback-only behavior). Environment override: `MINSKY_COCKPIT_ALLOWED_HOSTS` → comma-separated
  list, e.g. `MINSKY_COCKPIT_ALLOWED_HOSTS=my-node.tail1234.ts.net`.
- A request whose `Host` matches an entry here is also, by construction, treated as arriving
  off-box: the plain-HTTP cookie bootstrap is withheld for it regardless of the daemon's own bind
  address (see `src/cockpit/auth.ts`'s `cookieBootstrapMiddleware`/`buildOffBoxHostSet`) — a
  request via the standard loopback aliases is unaffected and keeps minting the cookie as before.
- Per the precedence order above, environment variables override the config-file value.

## Deployment Configuration

`deployment_status` / `deployment_wait-for-latest` / `deployment_logs` accept an optional
`service` argument (matching `services/<name>/deploy.config.ts`). When a project declares
more than one service and `service` is omitted, set a default so the tools don't need it on
every call (mt#2821):

```yaml
deployment:
  # Service name to use by default when a deployment tool is called without
  # an explicit `service` and the project has multiple deploy.config.ts files.
  defaultService: "minsky-mcp"
```

- `deployment.defaultService` — optional. Set via `minsky config set deployment.defaultService <name>`.
- When unset AND the project has multiple services, the tools also try one more fallback before
  erroring: if the process is itself running inside a Railway container, the platform-injected
  `RAILWAY_SERVICE_ID` variable is matched against each candidate's declared `railway.serviceId`.
- If neither resolves, the error lists every candidate service name — see
  [Deployment Platforms](./deployment-platforms.md#service-resolution).

## Observability (Braintrust)

Relocated from the top-level README (mt#3828).

To use Braintrust for LLM observability, both an API key and a project name are required.
The project name has **no default** — it must be set explicitly so traces do not silently
accumulate in a project named after someone else's installation:

```bash
# Configure via config
minsky config set observability.providers.braintrust.apiKey --value <your-key>
minsky config set observability.providers.braintrust.projectName --value <your-project>

# Or via environment variables
export BRAINTRUST_API_KEY=<your-key>
export BRAINTRUST_PROJECT_NAME=<your-project>

# Verify connectivity
minsky observability smoke-test
```

See `observability.providers.braintrust.projectName` in the configuration schema
(`packages/domain/src/configuration/schemas/observability.ts`).
