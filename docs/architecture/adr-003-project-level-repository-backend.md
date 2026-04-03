# ADR-003: Project-Level Repository Backend Configuration

## Status

**ACCEPTED** - Documented 2026-04-03

## Context

### Problem: Per-Session URL Pattern Matching Conflates Three Concepts

The current implementation in `repository-backend-detection.ts` determines the repository backend type (GitHub, local, remote) at session creation time by inspecting the clone URL and applying regex pattern matching rules. This approach conflates three fundamentally distinct concepts:

1. **Repository identity** — what project this is (e.g., `edobry/minsky`)
2. **Clone source** — where the session was cloned from (e.g., `https://github.com/edobry/minsky.git`, a local path, or an SSH remote)
3. **PR/collaboration backend** — which API to use for pull requests and code review (GitHub, GitLab, or none for local-only)

These three concepts are related but not equivalent. A repository's identity and PR backend are stable properties of the project itself. The clone source is an operational detail that may vary across machines, users, or CI environments. Deriving the PR backend from the clone URL introduces fragility:

- SSH vs HTTPS clone URLs for the same GitHub repo may not both match the detection regex
- Local forks, mirrors, or enterprise GitHub instances require custom detection rules
- Different team members may clone via different mechanisms (SSH, HTTPS, `gh` CLI), leading to inconsistent behavior
- Automated environments (CI, MCP server) may use different URLs than developers
- Every new session must re-derive what is already a fixed project property

### Technical Constraints

- **Stability**: The repository backend is a property of the project, not of the session or the user
- **Single source of truth**: Configuration derived multiple times from heuristics is error-prone
- **Explicitness**: Developers should know what backend is in use without needing to understand URL matching rules
- **Simplicity**: The correct backend should be determinable without network calls or file-system probes

## Decision

We adopt **project-level repository backend configuration** stored in `.minsky/config.yaml`.

The repository backend type is set once — at `minsky init` — when the project owner knows the correct backend and configures it explicitly. All subsequent operations (session creation, PR workflows) read this value directly from config rather than re-deriving it.

### Configuration Shape

```yaml
repository:
  backend: github          # "github" | "gitlab" | "local"
  url: https://github.com/edobry/minsky.git
  github:
    owner: edobry
    repo: minsky
```

### Schema

The configuration is validated with Zod schemas (see `src/domain/configuration/schemas/`):

- `repoBackendType` enum in `base.ts`: `"github" | "gitlab" | "local"`
- `repositoryGitHubConfigSchema` in `backend.ts`: `{ owner: string, repo: string }`
- `repositoryConfigSchema` in `backend.ts`: `{ backend, url?, github? }`
- Root `configurationSchema` in `index.ts`: includes `repository: repositoryConfigSchema.optional()`

The `RepositoryConfig` interface in `types.ts` mirrors this shape for YAML-facing config files.

### Separation from Task Backend

This `repository.backend` is **not** the same as `tasks.backend` (which controls where task data is stored: markdown files, JSON files, GitHub Issues, etc.). These are orthogonal concerns:

- `tasks.backend` — where task records live
- `repository.backend` — which VCS hosting platform manages PRs and code review

The existing `backendType` enum in `base.ts` and `backends` field in `RepositoryConfig` are for task storage backends and are unchanged.

## Rationale

### Single Derivation vs Repeated Heuristics

URL pattern matching must run for every session and may produce different results if the URL format changes or if the project is hosted on an enterprise instance. Project-level config is derived once at init time and remains stable for the life of the project.

### Explicitness Eliminates Ambiguity

When a developer runs `minsky init --backend github`, the intent is unambiguous. When the system infers the backend from a URL, the result may surprise users cloning via SSH, behind a proxy, or from a mirror.

### Enables GitHub Enterprise and GitLab Support

URL-matching approaches require maintaining regex rules for every possible host format. Explicit config trivially supports enterprise instances: the user sets `backend: github` regardless of their specific hostname.

### Consistent Across Environments

CI environments, developer machines, and MCP server processes may all use different clone URLs for the same repository. Reading from `.minsky/config.yaml` (a committed file) produces identical results in all environments.

## Alternatives Considered

### Alternative 1: Keep Per-Session URL Pattern Matching

**Rejected because**:
- Conflates clone source with project identity
- Produces inconsistent results across clone methods (SSH vs HTTPS)
- Requires duplicate derivation logic on every session start
- Does not support enterprise instances without custom detection rules
- Heuristics are inherently fragile as URL formats evolve

### Alternative 2: Environment Variable Override

Set `MINSKY_REPO_BACKEND=github` to override URL detection.

**Rejected because**:
- Environment variables are per-machine, not per-project
- Still requires fallback detection logic for unset environments
- Does not solve the consistency problem across CI and developer machines

### Alternative 3: Infer from Existing `github` Config Block

If `github.owner` and `github.repo` are present, assume GitHub backend.

**Rejected because**:
- Implicit coupling between unrelated config sections
- `github` config is for authentication, not repository identity
- Does not accommodate GitLab or future VCS providers
- Still a heuristic, just a different one

### Alternative 4: Detect at First Use and Cache

Detect the backend once and cache the result in a local state file.

**Rejected because**:
- Local state files are machine-specific and not version-controlled
- Cache invalidation is a solved problem only if the source of truth is explicit
- Adds complexity without eliminating the underlying heuristic

## Migration Path

1. **New projects**: `minsky init` detects the clone URL and prompts to confirm, then writes `repository.backend` to `.minsky/config.yaml`.

2. **Existing projects**: The `repository` key in `.minsky/config.yaml` is optional. When absent, the system falls back to the existing URL-detection heuristic (preserving backward compatibility). A migration command or warning can guide users to add the explicit config.

3. **Runtime behavior change**: Once `repository.backend` is set in config, `repository-backend-detection.ts` reads it directly and skips URL matching. This is a schema-only change — no runtime behavior is implemented in this ADR (see follow-up tasks).

## Implementation Notes

### Files Changed in This ADR

- `src/domain/configuration/schemas/base.ts` — Added `repoBackendType` enum
- `src/domain/configuration/schemas/backend.ts` — Added `repositoryGitHubConfigSchema` and `repositoryConfigSchema`
- `src/domain/configuration/schemas/index.ts` — Added `repository` field to root schema
- `src/domain/configuration/types.ts` — Updated `RepositoryConfig.repository` sub-object

### Files Not Changed (Future Work)

- `src/domain/repository-backend-detection.ts` — Runtime detection logic (follow-up task)
- `src/commands/init/` — `minsky init` prompting and config writing (follow-up task)
- Session creation code — Reading config instead of URL matching (follow-up task)

## Future Considerations

### GitLab Support

The `repoBackendType` enum includes `"gitlab"` from the start, though no GitLab-specific config block is defined yet. A `repositoryGitLabConfigSchema` can be added in a follow-up task when GitLab PR creation is implemented.

### Additional Repository Metadata

The `repository.url` field is optional and informational — it records the canonical URL for the project, which may differ from any given user's clone URL. This can be used for generating PR links or for display purposes.

## References

- `src/domain/repository-backend-detection.ts` — Current per-session URL matching implementation
- `src/domain/configuration/schemas/` — Configuration schema system
- [ADR-002: Persistence Provider Architecture](./adr-002-persistence-provider-architecture.md) — Precedent for capability-based configuration patterns

---

_This ADR documents the schema design decision for project-level repository backend configuration, establishing the config shape and type system before runtime behavior changes are implemented._
