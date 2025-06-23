# Minsky Configuration System

The Minsky configuration system is designed to be powerful and flexible, supporting individual developers, large teams, and automated CI/CD environments. It achieves this by separating repository-specific settings from user-specific settings.

## Core Concepts

1.  **Repository Configuration (`.minsky/config.yaml`)**:

    - **Purpose**: Defines settings that **must be consistent** for everyone working on the project.
    - **Location**: `.minsky/config.yaml` at the root of your repository.
    - **State**: This file **should be committed** to your repository.
    - **Controls**:
      - The default task backend (`markdown`, `json-file`, `github-issues`).
      - SessionDB storage backend for consistent team session management.
      - GitHub repository details (`owner`, `repo`) if using the `github-issues` backend.
      - Backend auto-detection rules.

2.  **Global User Configuration (`~/.config/minsky/config.yaml`)**:
    - **Purpose**: Defines a user's personal settings that apply **across all repositories**.
    - **Location**: In the XDG standard config directory (`~/.config/minsky/config.yaml` on Linux/macOS).
    - **State**: This file is global to the user and **should never be committed** to a repository.
    - **Controls**:
      - Personal credentials (like a GitHub Personal Access Token, PostgreSQL connection strings).
      - Credential source preferences.
      - Personal SessionDB preferences (SQLite database paths, etc.).
      - Future user-specific settings (e.g., UI preferences).

## Configuration Hierarchy

Minsky resolves settings by looking in the following places, in order of precedence (highest first):

1.  **Command-Line Flags**: Any flag like `--backend` will always take highest priority.
2.  **Environment Variables**: Variables like `MINSKY_BACKEND`, `MINSKY_SESSION_BACKEND`, or `GITHUB_TOKEN` are checked next.
3.  **Global User Config (`~/.config/minsky/config.yaml`)**: Your personal settings and credentials.
4.  **Repository Config (`.minsky/config.yaml`)**: The project-specific settings committed to the repo.
5.  **Built-in Defaults**: The sensible defaults that Minsky provides out-of-the-box.

## SessionDB Configuration

Minsky supports multiple SessionDB storage backends that can be configured at both repository and user levels:

### Available Backends

- **`json`**: Simple file-based storage (default)
- **`sqlite`**: Local SQLite database with ACID transactions
- **`postgres`**: PostgreSQL database for team environments

### Repository-Level SessionDB Configuration

Define consistent SessionDB settings for your entire team in `.minsky/config.yaml`:

```yaml
# .minsky/config.yaml
version: 1
sessiondb:
  backend: "postgres"
  connectionString: "${MINSKY_POSTGRES_URL}"
  baseDir: "/shared/minsky/sessions"
backends:
  default: "github-issues"
  github-issues:
    owner: "my-org"
    repo: "my-project"
```

### User-Level SessionDB Configuration

Store personal SessionDB preferences and credentials in `~/.config/minsky/config.yaml`:

```yaml
# ~/.config/minsky/config.yaml
version: 1
credentials:
  github:
    token: "ghp_xxxxxxxxxxxxxxxxxxxx"
  postgres:
    connection_string: "postgresql://user:password@localhost:5432/minsky"
sessiondb:
  backend: "sqlite"
  sqlite:
    path: "~/.local/state/minsky/sessions.db"
  base_dir: "~/.local/state/minsky/git"
```

### Environment Variable Overrides

SessionDB backends can also be configured via environment variables:

```bash
# Backend selection
export MINSKY_SESSION_BACKEND=postgres

# SQLite configuration
export MINSKY_SQLITE_PATH=~/.local/state/minsky/sessions.db

# PostgreSQL configuration
export MINSKY_POSTGRES_URL="postgresql://user:pass@host:5432/db"

# Base directory for session workspaces
export MINSKY_SESSIONDB_BASE_DIR=~/.local/state/minsky/git
```

## How It Works: A Walkthrough

### For Teams: Setting up a New Repository

1.  A team lead runs `minsky init` to create the repository configuration.

    ```bash
    minsky init --backend github-issues --github-owner my-org --github-repo my-project
    ```

2.  This creates a `.minsky/config.yaml` file:

    ```yaml
    # .minsky/config.yaml
    version: 1
    sessiondb:
      backend: "postgres"
      connectionString: "${MINSKY_POSTGRES_URL}"
      baseDir: "/shared/minsky/sessions"
    backends:
      default: "github-issues"
      github-issues:
        owner: "my-org"
        repo: "my-project"
    ```

3.  The lead commits this file. Now, the entire team is guaranteed to use the same GitHub issues backend for this project.

### For Users: Joining a Project

1.  A developer clones the repository, which includes the `.minsky/config.yaml` file.
2.  The first time they run a `minsky` command that requires credentials, Minsky will help them set up their global configuration.

    ```bash
    minsky tasks list
    ```

    If no `GITHUB_TOKEN` environment variable is found, Minsky will prompt:

    ```
    > GitHub token not found.
    > Please enter your token to be stored globally in ~/.config/minsky/config.yaml:
    > ghp_xxxxxxxxxxxxxxxxxxxx
    > Token saved. You won't be asked again on this machine.
    ```

3.  This creates a `~/.config/minsky/config.yaml` file for the user:

    ```yaml
    # ~/.config/minsky/config.yaml
    version: 1
    credentials:
      github:
        token: "ghp_xxxxxxxxxxxxxxxxxxxx"
    sessiondb:
      backend: "sqlite"
      sqlite:
        path: "~/.local/state/minsky/sessions.db"
    ```

4.  From now on, any `minsky` command in any repository will automatically use this global token.

## Credential Management

Security and flexibility are key. Minsky supports multiple ways to provide credentials:

1.  **Environment Variable (Highest Priority)**: Set `GITHUB_TOKEN` in your shell.
2.  **Global Config File**: Store the token directly in `~/.config/minsky/config.yaml` as shown above. This is convenient and secure as long as your home directory is protected.
3.  **Interactive Prompt**: If no credentials are found, Minsky will prompt you. This is ideal for constrained environments like a Cursor chat tab.

This layered approach ensures that CI/CD environments can use environment variables, while individual developers have a simple, one-time setup experience.
