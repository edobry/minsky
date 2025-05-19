# Workspace and Repository Concepts Relationship Diagram

```
+---------------------+
| WorkspaceResolution |
| Options             |
+---------------------+
| - workspace?:string |
| - sessionRepo?:string|
+--------+------------+
         |
         | Uses
         v
+---------------------+
| resolveWorkspacePath|
+---------------------+
| Resolves to a valid |
| workspace directory |
+--------+------------+
         |
         | Returns
         v
+---------------------+
| Workspace Path      |<------+
+---------------------+       |
| Physical path to a  |       |
| directory with      |       |
| process/ subdirectory|      |
+---------------------+       |
                              |
                              | Stored as
                              |
+---------------------+       |
| SessionRecord      |       |
+---------------------+       |
| - session: string   |       |
| - repoUrl: string   +-------+
| - repoName: string  |       |
| - taskId: string    |       |
| - repoPath: string  +-------+
| - createdAt: string |       |
| - ...               |       |
+---------------------+       |
         ^                    |
         | Manages            | Points to
         |                    |
+---------------------+       |
| SessionDB          |       |
+---------------------+       |
| - dbPath: string    |       |
| - baseDir: string   |       |
+---------------------+       |
                              |
+---------------------+       |
| RepoResolution     |       |
| Options            |       |
+---------------------+       |
| - session?: string  |       |
| - repo?: string     |       |
+--------+------------+       |
         |                    |
         | Uses               |
         v                    |
+---------------------+       |
| resolveRepoPath    |       |
+---------------------+       |
| Resolves to a repo |       |
| path               |       |
+--------+------------+       |
         |                    |
         | Returns            |
         v                    |
+---------------------+       |
| Repository Path    +-------+
+---------------------+
| Physical path to a |
| Git repository     |
+---------------------+
         ^
         | May be referenced as
         |
+---------------------+
| Repository URL     |
+---------------------+
| URL or file path   |
| to repository      |
| Can include        |
| file:// protocol   |
+---------------------+

```

## Path Structure Patterns

### Session Repository Path Patterns

```
1. Legacy Format:
   <minsky_state_home>/git/<repo_name>/<session_name>

   Example:
   /Users/user/.local/state/minsky/git/local-minsky/task#027

2. New Format:
   <minsky_state_home>/git/<repo_name>/sessions/<session_name>

   Example:
   /Users/user/.local/state/minsky/git/local-minsky/sessions/task#027
```

### Repository URL Formats

```
1. Local Repository Path:
   /Users/user/Projects/minsky

   Normalized as: local/minsky

2. Local Path with Protocol:
   file:///Users/user/Projects/minsky

   Normalized as: local/minsky

3. Remote HTTPS URL:
   https://github.com/user/project.git

   Normalized as: user/project

4. Remote SSH URL:
   git@github.com:user/project.git

   Normalized as: user/project
```

## Resolution Logic Flow

### Workspace Path Resolution

```
resolveWorkspacePath(options)
├── if options.workspace is provided
│   ├── validate by checking for process/ directory
│   ├── return options.workspace if valid
│   └── throw error if invalid
└── else
    ├── use options.sessionRepo or process.cwd()
    └── return that path
```

### Repository Path Resolution

```
resolveRepoPath(options)
├── if options.repo is provided
│   └── return options.repo
├── else if options.session is provided
│   ├── get session record from database
│   ├── return record.repoUrl
│   └── throw error if session not found
└── else
    ├── try to get current git repo with git rev-parse
    └── fall back to process.cwd() if git command fails
```

### Session Repository Detection

```
isSessionRepository(repoPath)
├── get git root with git rev-parse
├── check if root starts with minsky path
├── extract relative path from minsky directory
└── check if path matches known session patterns:
    ├── Legacy: <repo_name>/<session_name>
    └── New: <repo_name>/sessions/<session_name>
```
