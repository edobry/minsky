# Proposed Consistent Model for Workspace and Repository Concepts

## Core Concept Definitions

For clarity and consistency, we propose the following standardized definitions for core concepts in the Minsky codebase:

### 1. Workspace

**Definition**: A directory containing a Minsky project with a `process` subdirectory.

**Types**:

- **Main Workspace**: The primary workspace where the original repository exists and where tasks are managed. This is typically the user's main working directory.
- **Session Workspace**: A cloned copy of the main workspace created for working on a specific task. Located in the Minsky state directory.

**Representation**: Always represented as a filesystem path (string).

### 2. Repository Path

**Definition**: A filesystem path to a Git repository, used for local Git operations.

**Representation**: Always represented as an absolute filesystem path (string).

**Usage**: Used when performing Git operations like clone, status, push.

### 3. Repository URL

**Definition**: A reference to a Git repository, which may be:

- A remote URL (https://, git@)
- A local path (with or without file:// protocol)

**Representation**: String in one of these formats:

- `https://github.com/user/repo.git`
- `git@github.com:user/repo.git`
- `/path/to/repo`
- `file:///path/to/repo`

**Usage**: Stored in session records to reference the original repository.

### 4. Repository Name

**Definition**: A normalized identifier for a repository, derived from the repository URL.

**Format**:

- For remote repos: `org/project`
- For local repos: `local/project`

**Usage**: Used for naming session directories and organizing sessions.

### 5. Session Path

**Definition**: The filesystem path to a session repository clone.

**Format**: `<minsky_state_home>/git/<repo_name>/sessions/<session_name>`

**Usage**: Used to locate and operate on session repositories.

## Proposed Type Definitions

Based on these core concepts, we propose consolidating the type definitions as follows:

```typescript
// Core repository concepts
interface Repository {
  // Filesystem path to the repository
  path: string;

  // Repository URL (may be a local path or remote URL)
  url: string;

  // Normalized repository name (org/repo or local/repo)
  name: string;
}

// Workspace representation
interface Workspace {
  // Filesystem path to the workspace directory
  path: string;

  // Associated repository information
  repository: Repository;

  // Whether this is a session workspace or main workspace
  type: "main" | "session";
}

// Session information
interface Session {
  // Session identifier
  id: string;

  // Associated task ID (optional)
  taskId?: string;

  // Branch name
  branch: string;

  // Session workspace information
  workspace: Workspace;

  // Reference to the main workspace
  mainWorkspace: Workspace;

  // Creation timestamp
  createdAt: string;
}

// Resolution options
interface WorkspaceResolutionOptions {
  workspace?: string; // Explicit workspace path
  session?: string; // Session identifier
  repo?: string; // Repository path
}
```

## Proposed Path Resolution Strategy

To simplify path resolution and make it more consistent, we propose the following unified strategy:

### Workspace Resolution

```
resolveWorkspace(options: WorkspaceResolutionOptions): Workspace
├── if options.workspace is provided
│   ├── validate as workspace (check for process/ directory)
│   ├── return as main workspace if valid
│   └── throw error if invalid
├── else if options.session is provided
│   ├── get session record from database
│   ├── return associated session workspace
│   └── throw error if session not found
├── else if in a session repository (detected by path)
│   ├── determine session name from path
│   ├── get session record from database
│   └── return current session workspace
└── else
    └── return current directory as main workspace
```

### Repository Resolution

```
resolveRepository(options: WorkspaceResolutionOptions): Repository
├── if options.repo is provided
│   ├── validate as repository (check for .git directory)
│   ├── return as repository if valid
│   └── throw error if invalid
├── else if options.session is provided
│   ├── get session record from database
│   ├── return associated session repository
│   └── throw error if session not found
├── else if in a session repository (detected by path)
│   ├── determine session name from path
│   ├── get session record from database
│   └── return current session repository
└── else
    ├── try to get git repository from current directory
    └── throw error if not in a git repository
```

## Maintenance Strategy

To maintain consistency with this model, we recommend:

1. **Centralized Type Definitions**: Move all type definitions to a single location (e.g., `src/types/workspace.ts`)

2. **Common Utility Functions**: Create a set of core utility functions that implement the resolution strategy

3. **Documentation**: Add clear JSDoc comments to all functions that handle these concepts

4. **Legacy Support**: Maintain compatibility with the legacy path format but isolate this logic

5. **Gradual Migration**: Update code that uses these concepts incrementally rather than in one large refactor

## Implementation Plan

The implementation of this model should be broken down into the following steps:

1. Create new type definitions in a centralized location
2. Implement the unified resolution strategy
3. Update existing functions to use the new types
4. Add appropriate tests for the new functionality
5. Gradually migrate legacy code to use the new approach
6. Add documentation explaining the model

This approach allows for incremental improvement while maintaining compatibility with existing code.
