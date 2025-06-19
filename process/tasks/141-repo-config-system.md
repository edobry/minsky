# Implement Repository Configuration System

## Priority

High

## Summary

Create a minimal repository-level configuration system that allows users to set a default task backend per repository, with user-specific credentials managed in a global configuration file. This eliminates the need for manual `--backend` flags on every command and enables team-wide consistency.

## Context

Currently, backend configuration requires using `--backend` flags for every command. This creates friction for users and doesn't scale well for teams or repositories with multiple backend preferences. The system needs to support various deployment scenarios:

1. Single agent, single repo, local backend
2. Multiple agents, single repo with shared/local configs
3. Multiple agents, multiple repos with mixed backends
4. Multiple machines with environment-specific configs
5. Containerized deployments (Docker/K8s) with external config injection

A minimal repository configuration system would allow teams to set up default backends at the repository level, eliminating the need for manual `--backend` flags while maintaining simplicity and proper separation of concerns.

## Requirements

### Configuration Architecture

**Repository-Level Settings (Must Be Consistent Across All Users)**:

- Task backend selection (markdown, json-file, github-issues)
- GitHub repository owner/name (for github-issues backend)
- Backend auto-detection rules

**User-Level Settings (Global, Across All Repositories)**:

- GitHub tokens and other credentials
- Personal preferences (when added in future)

### Configuration Storage & Hierarchy

- [ ] Implement hierarchical configuration system with proper precedence:

  1. Command-line flags (highest priority)
  2. Environment variables (MINSKY\_\*)
  3. Global user config (`~/.config/minsky/config.yaml`) - Located in XDG dir for global user settings.
  4. Repository shared config (`.minsky/config.yaml`) - team-shareable, committed
  5. Built-in defaults (lowest priority)

- [ ] Support YAML configuration format
- [ ] Configuration validation and error reporting
- [ ] Multiple credential source options for constrained environments

### Configuration Schema

- [ ] **Repository Configuration** (`.minsky/config.yaml` - committed):

  - Task backend selection (MUST be consistent for all users)
  - GitHub repository settings (owner, repo)
  - Auto-detection rules based on repository characteristics

- [ ] **Global User Configuration** (`~/.config/minsky/config.yaml` - global):
  - GitHub tokens and credentials
  - Credential source configuration (environment, file, etc.)

### Backend Auto-Detection

- [ ] Smart backend detection based on repository characteristics:
  - GitHub remote exists → github-issues backend
  - `process/tasks.md` exists → markdown backend
  - Always fallback → json-file backend
- [ ] Configurable detection rules in repository config
- [ ] Override capability for manual backend selection

### Credential Management

- [ ] **Multiple credential sources** (checked in order):

  1. Environment variables (GITHUB_TOKEN)
  2. Global config file credentials (`~/.config/minsky/config.yaml`)
  3. Interactive prompts (for constrained environments)

- [ ] **Security measures**:
  - Validation warnings for unsafe credential storage
  - Clear error messages for missing credentials

### CLI Integration

- [ ] **Basic Configuration Commands**:

  - `minsky config list` - Show all configuration from all sources
  - `minsky config show` - Show the final resolved configuration

- [ ] **Enhanced Init Command**:

  - `minsky init --backend <backend>` - Initialize with backend
  - `minsky init --github-owner <owner> --github-repo <repo>` - GitHub setup
  - Repository configuration file generation

- [ ] **Environment Integration**:
  - Support for MINSKY_BACKEND environment variable (override only)
  - GitHub token via multiple sources
  - Interactive credential prompts when needed

### Developer Experience

- [ ] **Smart Defaults**:

  - Auto-detection of unconfigured repositories
  - Sensible defaults with override capability
  - Clear error messages for missing configuration
  - Automatic credential prompts in constrained environments

- [ ] **Team Collaboration**:
  - Clear separation of committed repository config vs. global user config
  - Validation of repository-wide settings consistency

## Repository vs User Configuration Separation

### Repository Config (`.minsky/config.yaml`) - Committed

```yaml
# This file is committed and MUST be consistent across all users
version: 1

# Task backend - ALL users must use the same backend for the same task database
backends:
  default: "github-issues" # REQUIRED: All users use this backend

  github-issues:
    owner: "acme-corp" # REQUIRED: All users use same GitHub repo
    repo: "project-name" # REQUIRED: All users use same GitHub repo

# Auto-detection rules - consistent across all users
repository:
  auto_detect_backend: true
  detection_rules:
    - condition: "github_remote_exists"
      backend: "github-issues"
    - condition: "tasks_md_exists"
      backend: "markdown"
    - condition: "always"
      backend: "json-file"
```

### Global User Config (`~/.config/minsky/config.yaml`) - In XDG directory

```yaml
# This file is stored globally and contains user-specific settings for ALL repositories
version: 1

# User-specific credential configuration
credentials:
  github:
    # Multiple credential source options
    source: "environment" # or "file", "prompt"
    token: "ghp_user_token" # only if source is "file"
    token_file: "~/.config/minsky/github-token" # only if source is "file"

# Future: User-specific preferences (UI settings, etc.)
```

## Acceptance Criteria

1. **Consistent Repository Backend**: All users of a repository MUST use the same task backend
2. **Zero-Config Experience**: Users can run `minsky tasks list` without `--backend` flags after setup
3. **Credential Security**: User credentials managed globally, not per-repo
4. **Team Shareable**: Repository configuration shared seamlessly, user config is global
5. **Constrained Environment Support**: Works in environments without environment variables
6. **Backward Compatible**: Existing CLI patterns continue to work
7. **Auto-Detection**: Repository setup detected automatically in `minsky init`

## Technical Approach

### CLI Examples

```bash
# Initialize repository (creates .minsky/config.yaml in the repo)
minsky init --backend github-issues --github-owner acme --github-repo project

# Setup global user credentials once (creates ~/.config/minsky/config.yaml)
minsky config credentials github --token ghp_xxxxx --global

# View configuration
minsky config list
minsky config show

# Environment variable override (for testing/CI)
export MINSKY_BACKEND=markdown  # overrides repo config temporarily
```

### Implementation Architecture

```typescript
interface ConfigurationService {
  loadConfiguration(workingDir: string): Promise<ResolvedConfig>;
  validateConfig(config: Config): ValidationResult;
}

interface ResolvedConfig {
  backend: string; // From repository config (must be consistent)
  backendConfig: BackendConfig; // From repository config
  credentials: CredentialConfig; // From global user config
  detectionRules: DetectionRule[]; // From repository config
}

interface CredentialManager {
  getCredential(service: string): Promise<string | null>;
  setGlobalCredential(service: string, source: CredentialSource): Promise<void>;
  promptForCredential(service: string): Promise<string>;
}
```

### Configuration Resolution Flow

```typescript
async function resolveConfig(workingDir: string): Promise<ResolvedConfig> {
  // 1. Load repository config (committed, consistent across users)
  const repoConfig = await loadRepositoryConfig(workingDir);

  // 2. Load global user config (from XDG dir)
  const userConfig = await loadGlobalUserConfig();

  // 3. Apply environment variable overrides
  const envOverrides = getEnvironmentOverrides();

  // 4. Merge with precedence: env > user > repo > defaults
  return mergeConfigs(envOverrides, userConfig, repoConfig, defaults);
}
```

## Dependencies

- YAML parser for configuration files (js-yaml)
- Configuration validation schema (Zod)
- Directory lookup utilities for XDG paths

## Estimated Effort

Medium (6-8 hours) - Focused minimal implementation

## Future Enhancements

The following features are intentionally deferred to keep this implementation minimal:

- Per-repository local user overrides (`.minsky/local.yaml`)
- Advanced credential management (keychain integration, external commands)
- Status label customization
- Session storage configuration
- Task ID format customization
- Environment-specific configuration sections
- Advanced configuration management commands (set, unset, validate)
- Configuration import/export

These can be addressed in future tasks if needed.

## Notes

- **Repository Backend Consistency**: Critical that all users use same task backend for same database
- **Clear Config Separation**: Repository settings (committed) vs global user settings (XDG dir)
- **Multiple Credential Sources**: Supports constrained environments without environment variables
- **Future Extensible**: Architecture supports additional features when needed

## Related Tasks

- #138: Add GitHub Issues Support as Task Backend (provides backend to configure)
- #047: Configure MCP Server in Minsky Init Command (init command integration)
- Future task: Advanced Configuration Features (for deferred functionality)
