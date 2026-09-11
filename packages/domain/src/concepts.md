# Core Minsky Concepts and Relationships

This document provides formal definitions for the core concepts in the Minsky system and how they relate to each other. These definitions aim to resolve inconsistencies in terminology and provide clear, standardized language for code, documentation, and discussions.

## 1. Core Concept Definitions

### Repository

A **Repository** is a Git repository identified by an upstream URI. From Minsky's perspective, upstream repositories are considered read-only sources of truth.

**Properties**:

- **URI**: A reference to the repository location (HTTPS, SSH, local file path)
- **Name**: A normalized identifier derived from the URI (org/repo or local/repo)

### Workspace

A **Workspace** is the per-task isolated Git clone plus branch that Minsky creates for
implementing one task. Each workspace is isolated and can be associated with a task ID. This is
the entity the `sessions` table, the `SessionRecord` type, the ~59 `session_*` tools, and
`~/.local/state/minsky/sessions/` still name "session" — a stage-1 naming convention under
ADR-022 (`docs/architecture/adr-022-session-vs-conversation-terminology.md`) that survives until
stage 2 (mt#2527) executes the mechanical `session_*` → `workspace_*` rename.

### Key Properties

- **session**: Unique identifier for the session
- **repoName**: Name of the repository
- **repoUrl**: URL of the repository
- **createdAt**: Timestamp when the session was created
- **taskId**: Optional task ID associated with the session
- **branch**: Git branch for the session
- **prState**: Optional PR state tracking for performance optimization

`SessionRecord` and the `minsky session` commands below keep their stage-1 names; they describe
the **Workspace** entity defined above, not a different concept.

### Session Record Structure

```typescript
export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  backendType?: "github";
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
  remote?: {
    authMethod?: "ssh" | "https" | "token";
    depth?: number;
  };
  branch?: string;
  prState?: {
    branchName: string;
    exists: boolean;
    lastChecked: string; // ISO timestamp
    createdAt?: string; // When PR branch was created
    mergedAt?: string; // When merged (for cleanup)
  };
}
```

### PR State Optimization

The `prState` field provides intelligent caching for PR workflow operations:

- **Performance**: Eliminates 2-3 git operations per approval (60-70% reduction in race conditions)
- **Cache Management**: 5-minute staleness threshold balances performance with data freshness
- **Graceful Fallback**: Automatically falls back to git operations when cache is missing or stale
- **Lifecycle Management**: Automatically updated on PR creation, merge, and cleanup operations
- **Backward Compatibility**: Optional field that doesn't affect existing session records

### Session Lifecycle

1. **Creation**: `minsky session start` creates a new session workspace
2. **Implementation**: Developer implements features in the isolated session
3. **PR Creation**: `minsky session pr` creates a PR branch with state tracking
4. **Approval**: `minsky session pr approve` merges the PR and updates state
5. **Cleanup**: Session state is maintained for audit and troubleshooting

### Conversation

A **Conversation** is the harness chat: a Claude Code conversation UUID, its transcripts, and
what `claude --resume` reconnects to. It is a distinct entity from a **Workspace** (see above) —
a workspace can outlive many conversations, and is not defined by any single one of them.

Bare **"session"** is not a Minsky vocabulary word for any sense — Workspace, Conversation, or
the MCP transport connection. It survives only as quoted foreign vocabulary, at four boundaries:
harness field names (`agent_session_id`, the stream-json `session_id` field); the frozen
`minsky://session/<uuid>` deeplink URI type; historical migration files that named it at the
time; and the frozen MCP transport artifact (`mcp-session-id` header handling, the
`McpSessionId` branded type), pending its retirement at mt#4608. Authority: ADR-022
(`docs/architecture/adr-022-session-vs-conversation-terminology.md`) and its
`## Amendment (2026-09-04)`, which also retires the MCP-transport sense.

A fourth sense, the **drive** — the cockpit's supervised subject-surface that spawns and
reconnects a harness process (`DrivenSessionRecord`) and adopts a series of conversations over
its life — is recorded under that working term in the same amendment. Its owned noun is an open
principal decision at ask#12011; this document does not choose one.

## 2. Relationship Diagram

```
+-----------------+                       +----------------------------+
| Repository      |<----------------------| Workspace                  |
+-----------------+      cloned into      | (code identifier:         |
| - URI           |                       |  "session", see ADR-022)  |
| - Name          |                       +----------------------------+
+-----------------+                       | - ID                      |
                                           | - Branch                  |
                                           | - Task ID (opt)           |
                                           | - Created Date            |
                                           | - Repo Reference          |
                                           | - Path                    |
                                           +----------------------------+
                                                        ^
                                                        | may be visited by
                                                        | a series of
                                                        |
                                           +----------------------------+
                                           | Conversation               |
                                           +----------------------------+
```

## 3. Key Relationships

1. Each **Session** is associated with exactly one upstream **Repository**.
2. **Session** is the current code identifier for the same entity this document calls
   **Workspace** (§1) — the two are not distinct objects in a containment relationship.
3. A **Repository** can be referenced by multiple **Sessions**.
4. A **Workspace** may be visited by zero, one, or (across the drive's conversation-adoption
   model) a series of **Conversations** over its lifetime.
5. Tasks can be associated with zero or one **Session** at any given time.

## 4. URI Handling Specification

Minsky supports the following repository URI formats:

### 4.1 Supported URI Formats

1. **HTTPS URLs**:

   - Format: `https://github.com/org/repo.git`
   - Normalized Name: `org/repo`

2. **SSH URLs**:

   - Format: `git@github.com:org/repo.git`
   - Normalized Name: `org/repo`

3. **Local Paths with file:// schema**:

   - Format: `file:///path/to/repo`
   - Normalized Name: `local/<repo-basename>`

4. **Plain Filesystem Paths**:

   - Format: `/path/to/repo`
   - Normalized Name: `local/<repo-basename>`

5. **GitHub Shorthand**:
   - Format: `org/repo`
   - Normalized Name: `org/repo`
   - Auto-expanded to: `https://github.com/org/repo.git`

### 4.2 URI Normalization Rules

1. URLs ending with `.git` have this suffix removed during normalization.
2. Local paths are normalized to `local/<basename>`.
3. GitHub shorthand (`org/repo`) is preserved as-is during normalization.
4. All URIs are normalized to their canonical form for consistency.

### 4.3 URI Validation Rules

1. All URIs must be syntactically valid.
2. Local paths must exist on the filesystem.
3. Remote URLs must use a supported protocol (https or ssh).
4. GitHub shorthand must follow the `org/repo` format.

## 5. Auto-detection Rules

### 5.1 Repository Auto-detection

When no explicit repository is specified:

1. The system attempts to find the Git repository containing the current working directory.
2. If a valid Git repository is found, it is used as the repository.
3. If no Git repository is found, an error is thrown.

### 5.2 Session Auto-detection

When no explicit session is specified:

1. The system checks if the current directory is within a known session workspace.
2. If it is, the corresponding session is used.
3. If not, the system assumes operation on the main workspace.

### 5.3 Fallback Mechanisms

1. If auto-detection fails but explicit options are provided, those options are used.
2. If both auto-detection and explicit options are unavailable, appropriate errors are thrown.

## 6. Usage Examples

### 6.1 Valid Usage Examples

```typescript
// Creating a session with a local repository
minsky session start --repo /path/to/local/repo --task 123

// Creating a session with a GitHub repository
minsky session start --repo https://github.com/org/project.git --name feature-x

// Using GitHub shorthand
minsky session start --repo org/project --task 123

// Auto-detecting the repository from current directory
minsky session start --task 123
```

### 6.2 Invalid Usage Examples

```typescript
// Invalid: Unsupported protocol
minsky session start --repo ftp://invalid-server.com/repo.git --task 123

// Invalid: Malformed GitHub shorthand
minsky session start --repo org/project/extra --task 123

// Invalid: Non-existent local path
minsky session start --repo /path/does/not/exist --task 123
```

## 7. Migration from Previous Terminology

ADR-022 (`docs/architecture/adr-022-session-vs-conversation-terminology.md`), amended
2026-09-04, resolved the historical overload of the word "session" into the senses below:

| Old word (bare "session")    | Current sense                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------- |
| session (per-task Git clone) | **Workspace** — code identifiers keep the "session" name until mt#2527 (stage 2) |
| session (harness chat)       | **Conversation**                                                                 |
| session (MCP transport)      | Retired — the frozen `mcp-session-id` artifact remains until mt#4608 retires it  |
| _(no prior word)_            | **The drive** — fourth sense; working term, owned noun pending ask#12011         |

Bare "session" is no longer a Minsky vocabulary word for any of these senses (see §1); it
survives only as quoted foreign vocabulary at the boundaries the amendment enumerates. For the
mechanical `session_*` → `workspace_*` identifier rename, see mt#2527.

## 8. Implementation Notes

1. All code should use these standardized terms consistently.
2. Type definitions should align with these concepts.
3. Path resolution strategies should follow the rules defined here.
4. Legacy code should be gradually migrated to use these concepts.
