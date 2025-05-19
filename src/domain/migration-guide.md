# Migration Guide: Core Minsky Concepts

This guide provides instructions for migrating code, documentation, and discussions from the previous inconsistent terminology to the new formalized concepts defined in `concepts.md`.

## 1. Terminology Changes

| Old Term           | New Term            | Explanation                                                                                                                                                                                                            |
| ------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main workspace     | Upstream repository | The term "main workspace" confused the concept of a workspace (a filesystem location) with a repository (a Git construct). The new term clarifies that this is the original repository that sessions are derived from. |
| Session repository | Session workspace   | Similar to above, this clarifies that we're referring to the working copy (workspace) of a session, not the repository concept itself.                                                                                 |
| Repo URL           | Repository URI      | The term "URI" is more accurate as it encompasses both remote URLs and local filesystem paths.                                                                                                                         |
| Repo path          | Workspace path      | Clarifies that this refers to the filesystem path where the workspace exists.                                                                                                                                          |
| Main repo          | Upstream repository | Standardizes on "repository" terminology for consistency.                                                                                                                                                              |

## 2. Code Update Guidelines

### 2.1 Variable and Parameter Names

When updating code, use these naming conventions:

```typescript
// Before
const mainWorkspace = "/path/to/repo";
const sessionRepo = "/path/to/session/repo";

// After
const upstreamRepo = "/path/to/repo";
const sessionWorkspace = "/path/to/session/workspace";
```

### 2.2 Function and Method Names

Update function names to reflect the new terminology:

```typescript
// Before
function resolveSessionRepoPath() { ... }
function getMainWorkspacePath() { ... }

// After
function resolveSessionWorkspacePath() { ... }
function getUpstreamRepositoryPath() { ... }
```

### 2.3 Comments and Documentation

Update JSDoc comments and other documentation to use the new terminology:

```typescript
// Before
/**
 * Gets the session repository path
 * @param session Session identifier
 * @returns Path to the session repository
 */

// After
/**
 * Gets the session workspace path
 * @param session Session identifier
 * @returns Path to the session workspace
 */
```

## 3. Type Updates

### 3.1 Interface Naming

Rename interfaces to match the new terminology:

```typescript
// Before
interface RepoPathOptions { ... }
interface WorkspaceOptions { ... }

// After
interface RepositoryOptions { ... }
interface WorkspaceOptions { ... }
```

### 3.2 Property Naming

Update property names in interfaces and objects:

```typescript
// Before
interface SessionRecord {
  repoUrl: string;
  mainWorkspace: string;
}

// After
interface SessionRecord {
  repositoryUri: string;
  upstreamRepository: string;
}
```

## 4. Migration Strategy

### 4.1 Phased Approach

We recommend a phased approach to migration:

1. First, update core domain files (repository.ts, session.ts, workspace.ts)
2. Next, update dependent modules that directly interact with these concepts
3. Finally, update CLI commands and user-facing components

### 4.2 Temporary Compatibility Layer

During migration, you may need to create temporary compatibility functions:

```typescript
/**
 * @deprecated Use resolveSessionWorkspacePath instead
 */
function resolveSessionRepoPath(options) {
  return resolveSessionWorkspacePath(options);
}
```

## 5. Testing During Migration

When updating terminology, ensure comprehensive test coverage:

1. Write tests that verify the behavior of new functions
2. Ensure old tests still pass during the transition
3. Update test assertions to use the new terminology

## 6. Documentation Updates

Remember to update these documentation sources:

1. README.md and other markdown files
2. JSDoc comments in code
3. CLI help text and error messages
4. User documentation and guides

## 7. Examples of Correct Usage

### 7.1 In Code

```typescript
// Creating a session
async function startSession(taskId: string, repositoryUri: string) {
  // Get the repository name from the URI
  const repoName = normalizeRepoName(repositoryUri);

  // Create a workspace for the session
  const sessionWorkspace = await createSessionWorkspace(repoName, `task#${taskId}`);

  // Store the session record
  await saveSessionRecord({
    session: `task#${taskId}`,
    repositoryUri,
    workspacePath: sessionWorkspace,
  });

  return sessionWorkspace;
}
```

### 7.2 In Comments

```typescript
/**
 * Resolves the workspace path for a given context
 *
 * Resolution strategy:
 * 1. If explicit workspace path is provided, use it
 * 2. If session is specified, use its workspace
 * 3. If in a session workspace, use the current directory
 * 4. Otherwise use current directory as workspace
 */
```

## 8. Common Pitfalls

1. **Mixing Concepts**: Avoid mixing workspace and repository concepts.
2. **Inconsistent Naming**: Be consistent with naming conventions.
3. **Incomplete Updates**: When updating a module, update all related code.
4. **Misleading Comments**: Ensure comments accurately reflect the code they describe.

By following this guide, you'll help create a more consistent, maintainable codebase that accurately reflects the conceptual model of Minsky.
