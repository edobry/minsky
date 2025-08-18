# Minsky Configuration System Guide

## Overview

The Minsky configuration system provides a centralized, validated approach to managing all configuration aspects including storage backends, session databases, AI providers, and credentials. This guide covers configuration precedence, validation, migration, and best practices.

## Configuration Precedence Order

Minsky follows a strict configuration precedence order, where higher-priority sources override lower-priority ones:

### 1. Command Line Arguments (Highest Priority)

```bash
minsky tasks list --backend=github-issues
minsky sessions start --sessiondb-backend=sqlite
```

### 2. Environment Variables

```bash
export MINSKY_SESSIONDB_BACKEND=postgres
export MINSKY_SESSIONDB_POSTGRES_CONNECTION_STRING="postgresql://user:pass@localhost/minsky"
export MINSKY_AI_DEFAULT_PROVIDER=openai
export MINSKY_WORKSPACE_MAIN_PATH="/absolute/path/to/main/workspace"  # NEW
```

### 3. User Configuration File (`~/.config/minsky/config.yaml`)

```yaml
version: 1
workspace:
  mainPath: "/absolute/path/to/main/workspace" # NEW
sessiondb:
  backend: sqlite
  sqlite:
    path: "~/.local/state/minsky/sessions.db"
```

### 4. Repository Configuration File (`.minsky/config.yaml`)

```yaml
version: 1
workspace:
  mainPath: "/absolute/path/to/main/workspace" # NEW
backends:
  default: "github-issues"
```

### 5. Default Configuration (Lowest Priority)

Built-in defaults ensure Minsky works out-of-the-box without any configuration.

## Workspace Configuration (NEW)

The `workspace` section allows specifying the absolute path to the main workspace root:

```yaml
workspace:
  mainPath: "/Users/you/Projects/minsky"
```

- When set, in-tree task backends (markdown, json-file) resolve `process/tasks.*` and task specs against `workspace.mainPath`.
- If unset, backends fall back to explicit `workspacePath` or `process.cwd()`.
- Environment override: `MINSKY_WORKSPACE_MAIN_PATH`.

## Notes

- This setting prevents accidental use of remote URLs or session workspace paths for task file operations.
