# Deployment-platform-aware MCP tools

This document describes Minsky's deployment-platform abstraction: how a project
declares its deployment target, the interface a platform adapter implements, and
the platform-neutral MCP tools agents call to observe deployments.

It is the reference for adapter authors. Railway is the v1 concrete adapter; the
same interface accepts Vercel, Cloudflare Pages, AWS Amplify, Fly.io, etc.

Tracking task: mt#1730.

## Why platform-agnostic from day one

Minsky integrates with whatever deployment platform a project uses. The repo
this document lives in uses Railway, but Minsky is a project-framework tool and
the next project it lands in may use a different platform. Locking the
agent-facing surface to Railway-specific names (`railway_logs`, etc.) at v1 would
force a breaking rename when the second platform arrives.

The cost of designing platform-neutrally at v1 is one indirection level in the
adapter (registry lookup at tool call time). The benefit is that adding Vercel
or Cloudflare to a project is one file (`services/<svc>/deploy.config.ts`) plus
one adapter registration.

The pattern mirrors:

- `session_pr_wait-for-review` — encapsulates GitHub's webhook plumbing. Same
  shape for any Git host.
- `TaskBackend` — Markdown, JSON, GitHub Issues all implement the same domain
  interface.
- `PersistenceProvider` — SQL, in-memory, etc. all behind the same capability
  interface.

## Configuration

### Service-level, platform-agnostic declaration

Each service declares its deployment target in `services/<svc>/deploy.config.ts`.
The file is platform-agnostic in name and content. The `platform` field is a
discriminator; the rest of the file is the platform-specific config.

```ts
// services/minsky-mcp/deploy.config.ts
import { defineDeployment } from "../../scripts/railway/lib";

export default defineDeployment({
  platform: "railway",
  railway: {
    projectId: "0e054318-7e19-4489-8e1e-de787965161d",
    environmentId: "0289b171-1514-4540-ac93-19b30da3e2c0",
    serviceId: "a7c5195f-55de-472a-87e4-34e921a15171",
  },
});
```

For Railway services that already declare these IDs in `railway.config.ts`
(the env-var synthesizer from mt#1437), the `railway` block can re-import them
to avoid duplication:

```ts
import { defineDeployment } from "../../scripts/railway/lib";
import railwayConfig from "./railway.config";

export default defineDeployment({
  platform: "railway",
  railway: {
    projectId: railwayConfig.projectId,
    environmentId: railwayConfig.environmentId,
    serviceId: railwayConfig.serviceId,
  },
});
```

A hypothetical Vercel adapter would declare:

```ts
// services/<svc>/deploy.config.ts
import { defineDeployment } from "...";

export default defineDeployment({
  platform: "vercel",
  vercel: {
    projectId: "...",
    teamId: "...",
  },
});
```

### Why service-level, not project-level

A Minsky project may have multiple services on different platforms (e.g., a
Vercel-hosted SPA + a Railway-hosted API). Service-level config accommodates the
multi-platform case without restructuring. v1 still has only one configured
service (`minsky-mcp`) for this repo; the file exists alongside the existing
`railway.config.ts` rather than replacing it.

### Service resolution

MCP tools accept an optional `service` argument. Resolution:

1. If `service` is passed, look up `services/<service>/deploy.config.ts`.
2. If `service` is omitted AND the project has exactly one `deploy.config.ts`,
   use it.
3. If `service` is omitted AND the project has multiple `deploy.config.ts`
   files, return a typed error listing the available services.

## Platform adapter interface

```ts
// src/domain/deployment/types.ts

export type PlatformName = "railway"; // v1 — extended by future adapters

export type DeploymentStatus =
  | "BUILDING"
  | "DEPLOYING"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED"
  | "CRASHED"
  | "UNKNOWN";

export interface DeploymentRecord {
  id: string;
  status: DeploymentStatus;
  commitHash: string | null;
  commitMessage: string | null;
  createdAt: string; // ISO8601
  finishedAt: string | null;
  durationMs: number | null;
  url: string | null; // deployment-specific URL if the platform exposes one
}

export type LogType = "build" | "deploy";

export interface LogLine {
  timestamp: string;
  severity: string; // platform-specific; "info" / "warn" / "error" common
  message: string;
}

export interface WaitForLatestOptions {
  /** Maximum time to block before giving up. Default 600s (10 min). */
  timeoutSeconds?: number;
  /** Poll interval. Default 10s. Adapter may ignore if it has a stream primitive. */
  pollIntervalSeconds?: number;
}

export interface DeploymentPlatformAdapter {
  /**
   * Block until the latest deployment for the configured service reaches a
   * terminal state (SUCCESS / FAILED / CANCELLED / CRASHED). Returns the
   * final record. Throws on timeout.
   */
  waitForLatestDeployment(options?: WaitForLatestOptions): Promise<DeploymentRecord>;

  /**
   * Read-only snapshot of the latest deployment. Does not block.
   */
  getLatestDeploymentStatus(): Promise<DeploymentRecord>;

  /**
   * Fetch logs for a specific deployment.
   */
  getDeploymentLogs(deploymentId: string, type: LogType, lines?: number): Promise<LogLine[]>;
}
```

### Status normalization

Each platform's native status set normalizes to the `DeploymentStatus` union.
Railway's `SUCCESS / FAILED / CRASHED / BUILDING / DEPLOYING / ERROR` maps as:

| Railway status | Normalized  |
| -------------- | ----------- |
| `SUCCESS`      | `SUCCESS`   |
| `FAILED`       | `FAILED`    |
| `CRASHED`      | `CRASHED`   |
| `BUILDING`     | `BUILDING`  |
| `DEPLOYING`    | `DEPLOYING` |
| `INITIALIZING` | `BUILDING`  |
| `WAITING`      | `BUILDING`  |
| `REMOVED`      | `CANCELLED` |
| `ERROR`        | `FAILED`    |
| _other_        | `UNKNOWN`   |

Adapters for other platforms map similarly. The agent-facing surface stays
neutral.

### Streaming logs out of scope for v1

`getDeploymentLogs` is block-and-return only. Streaming (`follow: true`) requires
an out-of-band notification path to deliver chunks to the agent's conversation
context; that's mt#1725's scope. v1 returns the last N lines (or all available)
in a single response.

## Adapter registry

```ts
// src/domain/deployment/registry.ts

export type AdapterFactory = (config: DeploymentConfig) => DeploymentPlatformAdapter;

const adapters = new Map<PlatformName, AdapterFactory>();

export function registerAdapter(name: PlatformName, factory: AdapterFactory): void {
  adapters.set(name, factory);
}

export function resolveAdapter(config: DeploymentConfig): DeploymentPlatformAdapter {
  const factory = adapters.get(config.platform);
  if (!factory) {
    throw new UnknownDeploymentPlatformError(config.platform, Array.from(adapters.keys()));
  }
  return factory(config);
}

export class UnknownDeploymentPlatformError extends Error {
  constructor(
    public readonly platform: string,
    public readonly registered: string[]
  ) {
    super(
      `Unknown deployment platform "${platform}". Registered: [${registered.join(", ") || "(none)"}]. ` +
        `Check services/<svc>/deploy.config.ts and ensure the adapter is registered.`
    );
    this.name = "UnknownDeploymentPlatformError";
  }
}
```

Adapters self-register at module load. The v1 `RailwayDeploymentAdapter` module's
top level calls `registerAdapter("railway", ...)`. No fallback or default
platform — explicit declaration in `deploy.config.ts` is required.

## MCP tool surface

Three platform-neutral tools, registered via the shared command registry.

### `deployment_wait_for_latest`

```
deployment_wait_for_latest(service?: string, timeoutSeconds?: number) -> DeploymentRecord
```

Blocks until the latest deployment for the (configured or specified) service
reaches a terminal state. Returns the final record. Throws on timeout. Throws
`UnknownDeploymentPlatformError` if the service's declared platform is
unregistered.

### `deployment_status`

```
deployment_status(service?: string) -> DeploymentRecord
```

Read-only snapshot of the latest deployment. Does not block.

### `deployment_logs`

```
deployment_logs(deploymentId: string, type?: "build" | "deploy", lines?: number, service?: string) -> { lines: LogLine[] }
```

Fetches logs for the specified deployment. Defaults: `type = "build"`,
`lines = 100`.

## Railway adapter (v1)

### Implementation strategy

The existing `scripts/railway/{lib,status,logs}.ts` already implement direct
Railway GraphQL against `https://backboard.railway.com/graphql/v2` with auth
from `~/.railway/config.json`. The v1 adapter extracts and reuses these
primitives:

- `readRailwayToken` (auth) — reused as-is.
- `graphql<T>` helper — moves to `src/domain/deployment/railway/graphql-client.ts`.
- `SERVICE_DEPLOYMENTS_QUERY` (from `scripts/railway/status.ts`) — reused for
  `getLatestDeploymentStatus`.
- `DEPLOYMENT_LOGS_QUERY` (from `scripts/railway/logs.ts`) — reused for
  `getDeploymentLogs`.
- **New:** `waitForLatestDeployment` — polls `SERVICE_DEPLOYMENTS_QUERY` until
  the first deployment's status is in the terminal set.

The bun-script entry points in `scripts/railway/` remain as thin CLI wrappers
over the domain module (no behavior change at the CLI layer; both surfaces share
the same code).

### Terminal status set

A Railway deployment is terminal when its status is one of `SUCCESS`, `FAILED`,
`CRASHED`, `CANCELLED`, `REMOVED`, `ERROR`. `BUILDING`, `DEPLOYING`, `INITIALIZING`,
`WAITING` are non-terminal.

### Polling cadence

Default 10s. Configurable via `WaitForLatestOptions.pollIntervalSeconds`. The
existing `scripts/railway/logs.ts` could be reused as a streaming primitive
(`railway logs --build <id>` streams build logs until terminal) but doing so
requires shelling out to the Railway CLI — out of scope for v1 per the spec.
v1 polls the `SERVICE_DEPLOYMENTS_QUERY` directly.

## Adding a new platform (Vercel example)

To add Vercel support:

1. **Author the adapter.** `src/domain/deployment/vercel/adapter.ts` implements
   `DeploymentPlatformAdapter`. Auth via Vercel access token; deployment data
   via the REST `/v6/deployments` endpoint.
2. **Register the adapter.** At module load, call
   `registerAdapter("vercel", (config) => new VercelDeploymentAdapter(config.vercel))`.
3. **Extend the `PlatformName` type.** Add `"vercel"` to the union in
   `src/domain/deployment/types.ts`.
4. **Document the config shape.** Add a section to this doc.
5. **Update `defineDeployment`'s schema** to accept the `vercel` config block.

No agent-facing change is required. The three MCP tools route to the new adapter
automatically once the service's `deploy.config.ts` declares `platform: "vercel"`.

## Cross-references

- `docs/deploy-minsky-railway.md` — Railway-specific runbook (deploy, config, env vars). The deployment-platform tools section there points back to this document for the platform-agnostic abstraction.
- `services/minsky-mcp/railway.config.ts` — env-var synthesizer manifest (mt#1437). Separate concern from this document; the `deploy.config.ts` file may import IDs from it.
- mt#1725 — sibling task: agent-context notification path. Out of scope for v1 of this document; constrains `getDeploymentLogs` to block-and-return.
- `feedback_external_system_event_wait_survey` — operational-knowledge bridge memory that motivated this design.
- `feedback_event_resumption_toolkit_survey` — Minsky-side analog of the toolkit-survey discipline.
