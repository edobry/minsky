# Task #146: Implement Repository Configuration System

## Context

Currently, GitHub Issues backend configuration requires setting up `.env` files and using `--backend` flags for every command. This creates friction for users and doesn't scale well for teams or repositories with multiple backend preferences.

A repository configuration system would allow teams to set up default backends and configuration at the repository level, eliminating the need for manual configuration on every command.

## Requirements

1. **Repository-Level Configuration**: Store backend preferences in repository configuration files
2. **Backend Auto-Detection**: Automatically select appropriate backends based on repository configuration
3. **Team Sharing**: Configuration files can be committed to repositories for team consistency
4. **Hierarchical Configuration**: Support global, repository, and local (user-specific) configuration
5. **Configuration Management CLI**: Commands to manage repository configuration
6. **Backward Compatibility**: Maintain compatibility with existing `.env` file approach

## Implementation Details

### Configuration File Structure
```yaml
# .minsky/config.yaml
backends:
  default: github-issues
  
github:
  token_source: environment  # or 'file' or 'keychain'
  status_labels:
    TODO: "minsky:todo"
    IN_PROGRESS: "minsky:in-progress"
    IN_REVIEW: "minsky:in-review"
    DONE: "minsky:done"

preferences:
  auto_create_labels: true
  sync_existing_issues: false
```

### CLI Integration
```bash
# Initialize repository configuration
minsky init --backend github-issues

# Configure default backend for repository
minsky config set backend github-issues

# Configure GitHub token source
minsky config set github.token_source environment

# View current configuration
minsky config list

# Remove configuration
minsky config unset backend
```

### Configuration Hierarchy
1. Command-line flags (highest priority)
2. Local user config (`.minsky/local.yaml`)
3. Repository config (`.minsky/config.yaml`)
4. Global user config (`~/.config/minsky/config.yaml`)
5. Environment variables (lowest priority)

## Acceptance Criteria

- [ ] Repository configuration file format defined and documented
- [ ] Automatic backend selection based on repository configuration
- [ ] CLI commands for managing repository configuration
- [ ] Hierarchical configuration resolution with proper precedence
- [ ] Team-shareable configuration files
- [ ] Auto-detection of repository setup in `minsky init`
- [ ] Backward compatibility with existing `.env` file approach
- [ ] Configuration validation and error reporting
- [ ] Documentation with setup examples for teams
- [ ] Migration guide from manual configuration

## Priority

High - Critical for improving user experience and team adoption of Minsky backends. 
