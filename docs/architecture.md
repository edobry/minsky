# Minsky Architecture Overview

This document describes how Minsky is structured at the system level. It covers the command dispatch
pipeline, domain model, persistence layer, session lifecycle, rules compilation, dependency injection,
configuration hierarchy, repository backend system, and the knowledge base integration. For narrower
topics, follow the links to the referenced ADRs.

---

## Table of Contents

1. [Shared Command Registry](#1-shared-command-registry)
2. [Domain Architecture](#2-domain-architecture)
3. [Persistence Architecture](#3-persistence-architecture)
4. [Session Model](#4-session-model)
5. [Rules Compilation Pipeline](#5-rules-compilation-pipeline)
6. [Dependency Injection](#6-dependency-injection)
7. [Configuration Hierarchy](#7-configuration-hierarchy)
8. [Repository Backend](#8-repository-backend)
9. [Knowledge Base](#9-knowledge-base)
10. [ADR Index](#10-adr-index)

---

## 1. Shared Command Registry

Minsky exposes the same operations through two interfaces — a CLI (Commander.js) and an MCP server —
without duplicating business logic. The shared command registry is the mechanism that makes this work.

### How it works

1. **Command definitions** are created with `defineCommand()` and registered into `SharedCommandRegistry`.
   Each definition carries an `id`, `category`, typed `parameters` (Zod schemas), and an `execute` handler.

2. **CLI Bridge** (`src/adapters/shared/bridges/cli-bridge-modular.ts`) reads the registry and generates
   Commander.js `Command` objects. Parameters marked `cliHidden: true` are omitted.

3. **MCP Bridge** (`src/adapters/shared/bridges/mcp-bridge.ts`) reads the same registry to dispatch
   MCP tool calls. Parameters marked `mcpHidden: true` are omitted.

```
  defineCommand({ id, category, parameters, execute })
          |
          v
  SharedCommandRegistry  (src/adapters/shared/command-registry.ts)
          |
    +-----+-----+
    |           |
    v           v
CLI Bridge    MCP Bridge
(Commander)   (MCP SDK)
    |           |
    v           v
 minsky CLI   mcp__minsky__* tools
```

### Command categories

Commands are grouped into `CommandCategory` enum values:

```
CORE  GIT  REPO  TASKS  SESSION  PERSISTENCE  RULES  INIT  CONFIG  DEBUG  AI  TOOLS  KNOWLEDGE
```

### Key types

- `CommandDefinition<T, R>` — typed definition with parameter map `T` and return type `R`
- `CommandParameterDefinition` — wraps a Zod schema, adds `required`, `defaultValue`, `cliHidden`, `mcpHidden`
- `CommandExecutionContext` — carries `interface` ("cli" | "mcp"), `workspacePath`, `format`, `debug`

Source: `src/adapters/shared/command-registry.ts`

---

## 2. Domain Architecture

Business logic lives exclusively in `src/domain/`. Adapters (`src/adapters/`) and infrastructure
(`src/mcp/`, `src/cli.ts`) depend on domain interfaces — never the reverse.

### Directory structure

```
src/domain/
├── ai/                  AI integration utilities
├── changeset/           Changeset creation and management
├── configuration/       Config loading, merging, validation
├── context/             Workspace context detection
├── git/                 Git operations (clone, commit, diff, etc.)
├── init/                Project initialization
├── interfaces/          Shared interface contracts (FsLike, etc.)
├── knowledge/           External knowledge source integration, ingestion pipeline, semantic search
├── persistence/         Persistence provider base types
├── project/             Project metadata reading
├── repository/          Repository backend abstraction
├── rules/               Rules CRUD and compilation pipeline
├── schemas/             Shared Zod schemas (session, task params)
├── session/             Session lifecycle operations
├── similarity/          Embedding-based similarity search
├── storage/             DB schemas and migrations
├── tasks/               Task CRUD, multi-backend routing
├── templates/           Template rendering
├── tools/               Tool indexing (MCP tool embeddings)
├── utils/               Shared utilities
└── workspace/           Workspace path resolution
```

### Subdomains

| Subdomain       | Responsibility                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `session`       | Isolated git workspaces tied to tasks; lifecycle from `start` to `approve`                                   |
| `tasks`         | Task CRUD with pluggable backends (GitHub Issues, Minsky DB)                                                 |
| `rules`         | Markdown rule files with frontmatter; compilation to AI assistant formats                                    |
| `git`           | Low-level git operations shared across domains                                                               |
| `configuration` | Hierarchical config loading (defaults → project → user → env)                                                |
| `repository`    | Forge backend abstraction (GitHub; GitLab/Bitbucket planned)                                                 |
| `persistence`   | PostgreSQL provider with optional pgvector capabilities                                                      |
| `changeset`     | Structured change tracking for session diffs                                                                 |
| `knowledge`     | External knowledge source integration (Notion, Confluence, Google Docs), ingestion pipeline, semantic search |

Formal concept definitions: `src/domain/concepts.md`

---

## 3. Persistence Architecture

Minsky uses a capability-based persistence provider pattern. See
[ADR-002](architecture/adr-002-persistence-provider-architecture.md) for the full rationale.

### Provider hierarchy

```
BasePersistenceProvider
        |
        v
PostgresPersistenceProvider
  capabilities: { sql, jsonb, migrations }
        |
        v (runtime — only if pgvector is installed)
PostgresVectorPersistenceProvider
  capabilities: { ..., vectorStorage: true }
  + getVectorStorage(dimension): VectorStorage
```

`PostgresProviderFactory.create()` probes the database at startup and returns the appropriate
subclass. Callers that need vector operations receive `PostgresVectorPersistenceProvider` and
get compile-time access to `getVectorStorage()`. Callers that don't need vectors receive the
base type and cannot accidentally call vector methods.

### DB schemas

Schema files under `src/domain/storage/schemas/` define the Postgres table layouts:

```
src/domain/storage/schemas/
├── embeddings-schema-factory.ts   shared factory for embeddings tables
├── rule-embeddings.ts             rule vector storage schema
├── session-schema.ts              session records table
├── task-embeddings.ts             task vector storage schema
├── task-relationships.ts          task dependency graph table
└── tool-embeddings.ts             MCP tool vector storage schema
```

Migrations live in `src/domain/storage/migrations/`.

### Design principles (from ADR-002)

- No DB connection for non-database commands (`minsky --help`, file operations)
- Tests use fake DI providers — never a real PostgreSQL instance
- Graceful degradation: commands fall back rather than fail when capabilities are unavailable

---

## 4. Session Model

A session is an isolated git clone of the upstream repository, associated with a task, where
implementation work happens before a PR is created and merged.

### Core types

```typescript
interface SessionRecord {
  session: string; // Unique identifier (UUID-like)
  repoName: string; // Normalized repo name (e.g., "edobry/minsky")
  repoUrl: string; // Clone URL
  createdAt: string; // ISO timestamp
  taskId?: string; // Plain task ID (e.g., "283", no "#" prefix)
  backendType?: "github" | "gitlab" | "bitbucket";
  prState?: {
    // Performance cache for PR branch status
    branchName: string;
    lastChecked: string;
    createdAt?: string;
    mergedAt?: string;
  };
  pullRequest?: PullRequestInfo;
  prBranch?: string; // "pr/<session-id>" when a PR branch exists
  prApproved?: boolean;
}
```

Source: `src/domain/session/types.ts`

### Lifecycle

```
  session start
      |
      v
  [ACTIVE] — git clone into ~/.local/state/minsky/sessions/<UUID>/
      |
      v
  [WORK IN PROGRESS] — developer edits, commits inside session workspace
      |
      v
  session pr create  (rebases on main, creates PR branch)
      |
      v
  [PR OPEN] — GitHub PR exists, CI runs
      |
      v
  session pr approve  (review submitted)
      |
      v
  session pr merge  (branch merged, session frozen)
      |
      v
  [FROZEN] — read-only; write operations refused
```

### SessionService

`SessionService` (`src/domain/session/session-service.ts`) is a class that holds injected
`SessionDeps` and delegates each operation to a pure function in a sub-module:

| Method         | Sub-module                        |
| -------------- | --------------------------------- |
| `get` / `list` | `session-lifecycle-operations.ts` |
| `start`        | `start-session-operations.ts`     |
| `update`       | `session-update-operations.ts`    |
| `review`       | `session-review-operations.ts`    |
| `approve`      | `session-approval-operations.ts`  |
| `delete`       | `session-lifecycle-operations.ts` |

Session records are stored in PostgreSQL via `SessionProviderInterface`.

---

## 5. Rules Compilation Pipeline

Rules are Markdown files with YAML frontmatter. The storage location depends on the configured
format: `.cursor/rules/` for Cursor format (current default in this project), `.minsky/rules/`
for Minsky-native format. They can be compiled into the formats expected by different AI coding
assistants.

### Rule structure

```typescript
interface Rule {
  id: string; // filename without extension
  name?: string; // frontmatter
  description?: string; // frontmatter
  globs?: string[]; // file patterns (for context-triggered rules)
  alwaysApply?: boolean; // included in every compilation
  tags?: string[]; // categorization
  content: string; // body (frontmatter stripped)
  format: "cursor" | "generic" | "minsky";
  path: string;
}
```

### Compilation pipeline

```
  RuleService.listRules()
       |
       v
  resolveActiveRules()           apply preset/enabled/disabled config
       |
       v
  classifyRuleType()             classify: always-on, glob-triggered, manual
       |
       v
  CompileTarget.compile()        format-specific rendering
       |
       +--> agents-md.ts         → AGENTS.md  (Codex / OpenAI Agents)
       +--> claude-md.ts         → CLAUDE.md  (Claude Code)
       +--> cursor-rules.ts      → .cursor/rules/*.mdc  (Cursor)
```

`CompileService` (`src/domain/rules/compile/compile-service.ts`) manages a registry of
`CompileTarget` implementations and routes `compile(targetId, options)` calls to the correct
one. Each target applies its own section layout and frontmatter stripping.

Rule selection configuration (presets, explicitly enabled/disabled IDs) is stored in
`.minsky/config.yaml` under the `rules` key.

---

## 6. Dependency Injection

The codebase uses [tsyringe](https://github.com/microsoft/tsyringe) for constructor-based
dependency injection. Domain code never references the DI container directly — it receives
typed dependency bundles (e.g., `SessionDeps`) assembled by composition roots.

### Container

`TsyringeContainer` (`src/composition/container.ts`) wraps tsyringe's `DependencyContainer`,
implementing `AppContainerInterface` with async lifecycle support:

- `register(key, factory, options?)` — stores a factory; returns `this` for chaining
- `set(key, instance)` — provides a pre-built instance (used in tests)
- `get(key)` — retrieves a resolved instance; throws if `initialize()` not called first
- `initialize()` — resolves all factories in registration order (sequential, supports async)
- `close()` — disposes services in reverse registration order

Registration order determines dependency resolution. Each factory may call `container.get()`
to access earlier-registered services. Async factories are bridged via `useValue` registration
into tsyringe after resolution.

### Tokens

String-based injection tokens are defined in `src/composition/tokens.ts`:

```typescript
export const TOKENS = {
  persistence: "persistence",
  sessionProvider: "sessionProvider",
  sessionDeps: "sessionDeps",
  gitService: "gitService",
  taskService: "taskService",
  taskGraphService: "taskGraphService",
  taskRoutingService: "taskRoutingService",
  workspaceUtils: "workspaceUtils",
  repositoryBackend: "repositoryBackend",
} as const;
```

These match the keys in the `AppServices` interface (`src/composition/types.ts`).

### Service map

```typescript
interface AppServices {
  persistence: BasePersistenceProvider;
  sessionProvider: SessionProviderInterface;
  sessionDeps: SessionDeps;
  gitService: GitServiceInterface;
  taskService: TaskServiceInterface;
  taskGraphService: TaskGraphService;
  taskRoutingService: TaskRoutingService;
  workspaceUtils: WorkspaceUtilsInterface;
  repositoryBackend: { repoUrl; backendType; github? };
}
```

Source: `src/composition/types.ts`

### Decorators

Service classes use tsyringe decorators:

- `@injectable()` — marks a class for DI participation
- `@inject("tokenName")` — injects a dependency by token on a constructor parameter

All service, adapter, and storage classes in `src/domain/` are decorated. Services with
primitive constructor params (e.g., `workspacePath: string`) use `@injectable()` only;
services whose constructor params match registered tokens also use `@inject()`.

**Polyfill requirement**: `import "reflect-metadata"` must be loaded before any decorated
class. It appears at the top of `src/cli.ts` (runtime) and `tests/setup.ts` (test preload).

**tsconfig**: Requires `experimentalDecorators: true` and `emitDecoratorMetadata: true`
(TC39 standard decorators don't support parameter metadata — TypeScript #57533).

### DI pattern for domain code

```
  TsyringeContainer (composition root)
       |  register factories
       v
  container.initialize()
       |  resolves in order, registers into tsyringe
       v
  container.get("sessionDeps") → SessionDeps
       |  passed to
       v
  @injectable()
  class SessionService(@inject("sessionDeps") deps)  ← domain sees only SessionDeps
```

Classes are used for stateful services; pure functions for stateless logic.
The container is wired in `src/composition/cli.ts` (CLI entry) and `src/composition/test.ts`
(test fakes via `set()`).

---

## 7. Configuration Hierarchy

Configuration is loaded from four sources in ascending priority order:

```
  1. Defaults         (src/domain/configuration/sources/defaults.ts)    lowest priority
  2. Project config   (.minsky/config.yaml in the project root)
  3. User config      (~/.config/minsky/config.yaml)
  4. Environment vars (MINSKY_* prefix)                                  highest priority
```

The loader (`src/domain/configuration/loader.ts`) merges these sources, validates the merged
result against `configurationSchema` (Zod), and returns a `ConfigurationLoadResult` that
includes per-key source tracking (which source set each value).

### Key configuration sections

```yaml
repository:
  backend: github # "github" | "gitlab" | "bitbucket"
  url: https://...
  github:
    owner: edobry
    repo: minsky

tasks:
  backend: github-issues # or "minsky"

rules:
  presets: [default]
  enabled: [rule-id, ...]
  disabled: [rule-id, ...]

ai:
  provider: openai
  model: text-embedding-3-small
```

Source: `src/domain/configuration/`

---

## 8. Repository Backend

The repository backend determines which API is used for pull requests and code review.
See [ADR-003](architecture/adr-003-project-level-repository-backend.md) for the original project-level
config decision and [ADR-005](architecture/adr-005-forgebackend-subinterfaces.md) for the current
`ForgeBackend` sub-interface architecture.

### Problem solved

Earlier versions derived the backend from the clone URL at session creation time (SSH vs HTTPS
patterns). This was fragile across machines and CI environments. ADR-003 moves the decision to
project-level config, set once at `minsky init`.

### Current architecture

The repository backend implements `ForgeBackend` (extends `RepositoryBackend`) with three sub-interfaces:

| Sub-interface    | Methods                                        |
| ---------------- | ---------------------------------------------- |
| `backend.pr`     | `create`, `update`, `merge`, `get`, `getDiff`  |
| `backend.ci`     | `getChecksForRef`, `getChecksForPR`            |
| `backend.review` | `approve`, `getApprovalStatus`, `submitReview` |

Currently only GitHub is implemented (`GitHubBackend`). GitLab and Bitbucket are recognized in config/detection but throw "not yet implemented" at runtime.

The active backend is read from `.minsky/config.yaml` (`repository.backend`). All session operations route through the sub-interfaces, which are resolved by `createRepositoryBackend()` at runtime.

Source: `src/domain/repository/`

---

## 9. Knowledge Base

The knowledge base subsystem lets Minsky index external documentation sources and make them
available for semantic search. Phase 2a (shipped) covers Notion and Google Docs providers,
cron-based sync scheduling, and a structured search response with freshness and authority ranking.
Phase 2b (mt#1027, pending) will add clustering and conflict/redundancy detection.

### Provider interface

Every knowledge source implements `KnowledgeSourceProvider`:

```typescript
interface KnowledgeSourceProvider {
  sourceType: string;
  sourceName: string;
  listDocuments(options?: ListOptions): AsyncIterable<KnowledgeDocument>;
  fetchDocument(id: string): Promise<KnowledgeDocument>;
  getChangedSince(since: Date, options?: ListOptions): AsyncIterable<KnowledgeDocument>;
}
```

Shipped providers:

- `NotionKnowledgeProvider` (`src/domain/knowledge/providers/notion-provider.ts`) — walks a
  Notion page tree via the Notion REST API.
- `GoogleDocsKnowledgeProvider` (`src/domain/knowledge/providers/google-docs-provider.ts`) —
  syncs documents from a Google Drive folder or an explicit document ID list. Supports OAuth
  access tokens and service account JSON key authentication.

Providers are loaded lazily via dynamic `import()` so neither SDK is bundled unless the source
type is configured.

### Ingestion pipeline

```
  KnowledgeSourceProvider.listDocuments()
            |
            v
  [SHA-256 content hash check]   skip unchanged documents (unless force=true)
            |
            v
  chunkContent()                 hierarchical split: ## → ### → paragraphs → tokens
            |
            v
  EmbeddingService.generateEmbedding()   one call per chunk
            |
            v
  VectorStorage.store(id, vector, metadata)
```

`chunkContent` (`src/domain/knowledge/ingestion/chunker.ts`) uses a four-level strategy:

1. If the whole document fits (≤ 8 192 tokens), return it as-is.
2. Split on `##` level-2 headings.
3. Split oversized sections on `###` level-3 headings.
4. Split remaining oversized sections on paragraph boundaries (`\n\n`).
5. Last resort: hard split by token count.

Each chunk ID is `{sourceName}:{documentId}:{chunkIndex}`, stored alongside metadata that
includes `contentHash`, `totalChunks`, `url`, `title`, `lastModified`, and `stale` flag.

`runSync` (`src/domain/knowledge/ingestion/sync-runner.ts`) orchestrates the pipeline for a
single provider and returns a `SyncReport` with counts of added, updated, skipped, and removed
documents.

### Sync scheduler

`KnowledgeSyncScheduler` (`src/domain/knowledge/ingestion/scheduler.ts`) fires sync jobs
according to each source's `sync.schedule` setting. Supported values:

- Named presets: `on-demand`, `startup`, `hourly`, `daily`, `weekly`
- Any valid 5-field cron expression (e.g. `"0 */6 * * *"` for every 6 hours)

The scheduler uses a setTimeout chain — the next fire time is recomputed from the current clock
after each run, so late fires skip forward rather than trying to catch up (missed-run policy:
skip forward, do not replay).

#### Scheduler lifecycle

The scheduler is constructed and started inside the **MCP server startup path** only
(`src/commands/mcp/start-command.ts`, via `buildAndStartScheduler` in
`src/commands/mcp/scheduler-wiring.ts`). It is deliberately absent from any CLI-only
code path, satisfying ADR-002 ("no DB on `minsky --help`").

Startup sequence:

1. `registerAllTools()` completes, initializing the DI container (persistence + services ready).
2. `buildAndStartScheduler(container)` is called. It reads `knowledgeBases` from config, filters
   sources with a non-`on-demand` schedule, builds `EmbeddingService` + `VectorStorage`, and
   constructs the provider for each source.
3. If at least one schedulable source exists, `KnowledgeSyncScheduler.start()` is called.
   Sources with no auto-schedule (i.e. `on-demand`) are silently skipped.
4. On SIGINT / SIGTERM: `scheduler.stop()` is awaited before `server.drain()`, so any in-flight
   sync completes before the process exits. This prevents partial index writes.

If provider construction for a source fails (e.g. missing API key), that source is logged at
`warn` level and excluded from the scheduler — the other sources still run. If no schedulable
source can be built, `buildAndStartScheduler` returns `null` and no scheduler is registered.

The scheduler supports `runNow(sourceName?)` for manual triggering without affecting the
next scheduled fire time.

### KnowledgeService

`KnowledgeService` (`src/domain/knowledge/knowledge-service.ts`) is the entry point for
application code. It reads `knowledgeBases` from config, instantiates the correct provider,
and delegates to `runSync`:

```typescript
interface KnowledgeServiceDeps {
  embeddingService: EmbeddingService;
  vectorStorage: VectorStorage;
  config: { knowledgeBases: KnowledgeSourceConfig[] };
}
```

### Search output shape (Phase 2a)

`knowledge.search` now returns a structured `KnowledgeSearchResponse` (defined in
`src/domain/knowledge/types.ts`) instead of a bare chunk list:

```typescript
interface KnowledgeSearchResponse {
  chunks: ChunkResult[]; // primary result list — relevance (score) order
  freshness: Record<
    ChunkId,
    {
      // per-chunk staleness metadata
      lastModified: string; // ISO 8601 timestamp
      staleness: "fresh" | "aging" | "stale";
    }
  >;
  authority: ChunkId[]; // chunks re-sorted by (sourceAuthority, score)
  conflicts: ChunkConflict[]; // stub — empty until Phase 2b (mt#1027)
  redundancies: ChunkRedundancy[]; // stub — empty until Phase 2b (mt#1027)
}
```

**Backward compat:** existing consumers that read only `response.chunks` keep working — the
response is a strict superset.

**Freshness classification** (`src/domain/knowledge/reconciliation/freshness.ts`):

- `fresh` — modified within `agingDays` (default 30 days)
- `aging` — modified between `agingDays` and `staleDays` (default 30–90 days)
- `stale` — not modified for more than `staleDays` (default 90 days)

Thresholds are configurable via `knowledgeReconciliation.staleness` (see Configuration below).
The MCP/CLI output surfaces staleness inline per chunk (e.g. stale chunks appear with a warning
in the freshness map).

**Authority ranking** (`src/domain/knowledge/reconciliation/authority-ranker.ts`):
When two chunks' relevance scores are within `epsilon` (default 0.05), the higher-authority
source is preferred. Authority scores are set via `knowledgeReconciliation.sourceAuthority`
(unlisted sources default to 0). `authority` is a parallel ordering — `chunks` retains
pure relevance order.

### MCP tools

Four commands registered under `CommandCategory.KNOWLEDGE` expose knowledge operations:

| Command             | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `knowledge.search`  | Semantic search — returns `KnowledgeSearchResponse` (Phase 2a) |
| `knowledge.fetch`   | Live-fetch a single document from a source by ID               |
| `knowledge.sources` | List configured knowledge sources and their sync status        |
| `knowledge.sync`    | Sync one or all sources into the vector index                  |

Source: `src/adapters/shared/commands/knowledge/index.ts`

### MCP Resources

Knowledge content is also accessible as MCP Resources (passive reads, no tool call required):

| URI pattern                             | Description                                     |
| --------------------------------------- | ----------------------------------------------- |
| `knowledge://sources`                   | Lists all configured sources and sync schedules |
| `knowledge://{sourceName}`              | Lists metadata for a specific source            |
| `knowledge://{sourceName}/{documentId}` | Live-fetches a single document                  |

Source: `src/adapters/mcp/knowledge-resources.ts`

### Configuration

Knowledge sources are declared in `.minsky/config.yaml` under the `knowledgeBases` key:

```yaml
knowledgeBases:
  - name: my-notion-docs
    type: notion
    rootPageId: <page-id>
    auth:
      tokenEnvVar: NOTION_TOKEN
    sync:
      schedule: daily # named preset or 5-field cron, e.g. "0 2 * * *"
      maxDepth: 5
      excludePatterns:
        - "**/Archive/**"

  - name: team-prds
    type: google-docs
    driveFolderId: <folder-id> # walk a Drive folder recursively
    auth:
      serviceAccountJsonEnvVar: GOOGLE_SA_JSON
    sync:
      schedule: "0 */6 * * *" # every 6 hours via cron

knowledgeReconciliation:
  staleness:
    agingDays: 30 # default: 30 — chunks older than this are "aging"
    staleDays: 90 # default: 90 — chunks older than this are "stale"
  sourceAuthority:
    team-prds: 10 # higher = more authoritative
    my-notion-docs: 5
  epsilon: 0.05 # max relevance delta for authority tiebreaking
```

The `KnowledgeSourceConfig` type is defined in `src/domain/knowledge/types.ts`. The
`knowledgeReconciliation` section is defined in
`src/domain/configuration/schemas/knowledge-reconciliation.ts` and validated by Zod.

Auth tokens can be provided directly (`token:`) or via an environment variable name
(`tokenEnvVar:`); Google Docs additionally supports `serviceAccountJsonEnvVar:` for service
account auth. At least one auth method must be set.

---

## 10. ADR Index

| ADR                                                                  | Title                                                                 | Status   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| [ADR-002](architecture/adr-002-persistence-provider-architecture.md) | Persistence Provider Architecture with Type-Safe Capability Detection | Accepted |
| [ADR-003](architecture/adr-003-project-level-repository-backend.md)  | Project-Level Repository Backend Configuration                        | Accepted |
| [ADR-004](architecture/adr-004-two-phase-command-execution.md)       | Two-Phase Command Execution                                           | Accepted |
| [ADR-005](architecture/adr-005-forgebackend-subinterfaces.md)        | ForgeBackend Sub-Interfaces for Multi-Provider PR/CI/Review           | Accepted |
| [ADR-006](architecture/adr-006-agent-identity.md)                    | Agent Identity Scheme for MCP Callers                                 | Accepted |
| [ADR-007](architecture/adr-007-cognition-provider-abstraction.md)    | Cognition Provider Abstraction for Multi-Mode AI Operation            | Proposed |

Additional architectural context:

- `docs/architecture/interface-agnostic-commands.md` — CLI/MCP command unification design
- `docs/architecture/multi-backend-task-system-design.md` — task backend routing design
- `src/domain/concepts.md` — formal definitions for Repository, Session, Workspace, and URI handling
