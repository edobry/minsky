# Project Identity: MCP Multi-Repo Resolution (v1)

**Task:** mt#2414 (Phase 1.1 of mt#2391)

## Background

`resolveProjectIdentity()` (in `packages/domain/src/project/identity.ts`) is the
single source of truth for "which project am I operating on right now." It follows
a four-tier precedence chain:

1. Explicit CLI flag (`--project`)
2. Environment variable: `MINSKY_PROJECT`
3. `.minsky/config.yaml` `project.slug` field
4. Git-remote auto-detect: `owner/repo` from the `origin` remote

## The multi-repo problem

The Minsky MCP server may serve client sessions from **different repositories
simultaneously** — for example, an agent session for `org/repo-a` and another for
`org/repo-b` both connected to the same `minsky mcp start --http` instance.

A naive "resolve project identity at server startup and cache forever" approach
would:

1. Return a stale identity for new sessions that connect from a different repo.
2. Not handle the common case of a developer who switches repos between sessions.

## v1 decision: per-request resolution

In v1, project identity is resolved **per request**, derived from the request's
`ProjectContext.repositoryPath` (the `--repo` CLI argument, or the CWD of the
request context).

**Concretely:** callers pass `repoPath: projectContext.repositoryPath` to
`resolveProjectIdentity()` on each call. There is no server-lifetime "current project"
— the identity is always derived fresh from the request's repo path.

### Why this is the right v1 posture

- The MCP server is already stateless with respect to repository path — every command
  that needs a repo path accepts it as a parameter or reads it from `ProjectContext`.
- Per-request resolution is cheap: it reads a YAML file + runs `git remote get-url origin`,
  both of which are fast local I/O.
- It avoids the class of bugs where a long-lived server process returns the wrong identity
  after a new session comes in from a different directory.

### Documented constraint

This v1 approach means there is **no server-lifetime project context**. If a future
requirement needs a stable server-lifetime identity (e.g., for pooled-connection caching
by project), that should be addressed in Phase 2 as an explicit design decision — not by
silently caching the first resolved identity.

## Acceptance test location

`packages/domain/src/project/identity.test.ts` § "MCP multi-repo — per-request resolution"
asserts the v1 behavior: two concurrent `resolveProjectIdentity()` calls with different
`repoPath` values return independent identities.

## Cross-references

- `packages/domain/src/project/identity.ts` — resolver implementation (full module-level
  JSDoc restates the decision above)
- mt#2414 — this task
- mt#2391 — Phase 1 parent
- mt#2415 — Phase 1.2 (adds `project_id` / `project_slug` columns to the DB schema)
- mt#2416 — Phase 1.3 (query scoping by project)
