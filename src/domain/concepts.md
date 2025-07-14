# Core Minsky Concepts and Relationships

This document provides formal definitions for the core concepts in the Minsky system and how they relate to each other. These definitions aim to resolve inconsistencies in terminology and provide clear, standardized language for code, documentation, and discussions.

## 1. Core Concept Definitions

### Repository

A **Repository** is a Git repository identified by an upstream URI. From Minsky's perspective, upstream repositories are considered read-only sources of truth.

**Properties**:

- **URI**: A reference to the repository location (HTTPS, SSH, local file path)
- **Name**: A normalized identifier derived from the URI (org/repo or local/repo)

### Session

A Session represents a workspace for implementing a specific task or feature. Each session is isolated and can be associated with a task ID.

### Key Properties

- **session**: Unique identifier for the session
- **repoName**: Name of the repository
- **repoUrl**: URL of the repository
- **createdAt**: Timestamp when the session was created
- **taskId**: Optional task ID associated with the session
- **branch**: Git branch for the session
- **prState**: Optional PR state tracking for performance optimization

### Session Record Structure

```typescript
export interface SessionRecord {
  session: string;
  repoName: string;
  repoUrl: string;
  createdAt: string;
  taskId?: string;
  backendType?: "local" | "remote" | "github";
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
    createdAt?: string;   // When PR branch was created
    mergedAt?: string;    // When merged (for cleanup)
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
4. **Approval**: `minsky session approve` merges the PR and updates state
5. **Cleanup**: Session state is maintained for audit and troubleshooting

### Workspace

A **Workspace** is the filesystem location where a session's working copy exists. It is the physical manifestation of a session on disk.

**Properties**:

- **Path**: Absolute filesystem path to the workspace directory
- **Type**: Either a session workspace or main workspace

## 2. Relationship Diagram

```
+-----------------+     references     +------------------+
| Repository      |<-------------------| Session          |
+-----------------+                    +------------------+
| - URI           |                    | - ID             |
| - Name          |                    | - Branch         |
+-----------------+                    | - Task ID (opt)  |
       ^                               | - Created Date   |
       |                               | - Repo Reference |
       | cloned into                   +------------------+
       |                                       |
       |                                       | has exactly one
       |                                       v
       |                               +------------------+
       +------------------------------>| Workspace        |
           workspace points to         +------------------+
                                       | - Path           |
                                       | - Type           |
                                       +------------------+
```

## 3. Key Relationships

1. Each **Session** is associated with exactly one upstream **Repository**.
2. Each **Session** has exactly one **Workspace**.
3. A **Repository** can be referenced by multiple **Sessions**.
4. A **Workspace** is always associated with a single **Session**.
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

| Previous Term      | New Term            | Notes                                              |
| ------------------ | ------------------- | -------------------------------------------------- |
| Main workspace     | Upstream repository | The original repository that sessions are based on |
| Session repository | Session workspace   | The working copy of a session                      |
| Repo URL           | Repository URI      | More general term that includes local paths        |
| Repo path          | Workspace path      | The physical location of the workspace             |

## 8. Implementation Notes

1. All code should use these standardized terms consistently.
2. Type definitions should align with these concepts.
3. Path resolution strategies should follow the rules defined here.
4. Legacy code should be gradually migrated to use these concepts.
