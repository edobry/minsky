# Core Minsky Concepts and Relationships

This document provides formal definitions for the core concepts in the Minsky system and how they relate to each other. These definitions aim to resolve inconsistencies in terminology and provide clear, standardized language for code, documentation, and discussions.

## 1. Core Concept Definitions

### Repository

A **Repository** is a Git repository identified by an upstream URI. From Minsky's perspective, upstream repositories are considered read-only sources of truth.

**Properties**:

- **URI**: A reference to the repository location (HTTPS, SSH, local file path)
- **Name**: A normalized identifier derived from the URI (org/repo or local/repo)

### Session

A **Session** is a persistent workstream with metadata and an associated workspace. It represents a unit of work, typically tied to a specific task.

**Properties**:

- **ID**: A unique identifier for the session
- **Branch**: The Git branch associated with the session
- **Task ID** (optional): Reference to the task being worked on
- **Created Date**: When the session was created
- **Repository Reference**: Reference to the upstream repository

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
minsky session start --repo ftp://example.com/repo.git --task 123

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
