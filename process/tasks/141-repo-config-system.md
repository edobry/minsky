# Implement Repository Configuration System

## Status

TODO

## Priority

High

## Summary

Create a repository-level configuration system that allows users to set default task backend, authentication, and other settings per repository. This eliminates the need for manual configuration on every command and enables team-wide consistency.

## Context

Currently, GitHub Issues backend configuration requires setting up `.env` files and using `--backend` flags for every command. This creates friction for users and doesn't scale well for teams or repositories with multiple backend preferences.

A repository configuration system would allow teams to set up default backends and configuration at the repository level, eliminating the need for manual configuration on every command.

## Requirements

### Configuration Storage

- [ ] Implement `.minsky/config.yaml` for repo-level config
- [ ] Support hierarchical configuration with proper precedence
- [ ] Secure storage for sensitive data (tokens, credentials)
- [ ] Migration path from environment variables
- [ ] Team-shareable configuration files

### Configuration Hierarchy

1. Command-line flags (highest priority)
2. Local user config (`.minsky/local.yaml`)
3. Repository config (`.minsky/config.yaml`)
4. Global user config (`~/.config/minsky/config.yaml`)
5. Environment variables (lowest priority)

### Configuration Options

- [ ] Default task backend (markdown, json-file, github-issues)
- [ ] GitHub repository settings (owner, repo, token reference)
- [ ] Backend auto-detection based on repository configuration
- [ ] Custom status labels for GitHub backend
- [ ] Task ID generation preferences
- [ ] Session storage preferences

### CLI Integration

- [ ] `minsky init --backend <backend>` - Initialize repository configuration
- [ ] `minsky config set <key> <value>` - Set configuration values
- [ ] `minsky config get <key>` - Get configuration values
- [ ] `minsky config list` - Show all configuration
- [ ] `minsky config unset <key>` - Remove configuration
- [ ] Auto-detection of unconfigured repositories

### Security Features

- [ ] Never store tokens directly in config files
- [ ] Support for token references (env var names, keychain, etc.)
- [ ] Secure credential storage integration (OS keychain)
- [ ] Clear security warnings for unsafe practices

### Developer Experience

- [ ] Auto-prompt for configuration on first use
- [ ] Sensible defaults with override capability
- [ ] Clear error messages for missing configuration
- [ ] Configuration validation and migration tools
- [ ] Automatic backend selection based on repository configuration

## Acceptance Criteria

1. Users can run `minsky tasks list` without any flags after initial setup
2. Configuration is stored securely and portably
3. Team members can share non-sensitive configuration
4. Token/credential management follows security best practices
5. Backward compatibility with existing `.env` file approach
6. Repository configuration file format defined and documented
7. Hierarchical configuration resolution with proper precedence
8. Auto-detection of repository setup in `minsky init`
9. Configuration validation and error reporting
10. Documentation with setup examples for teams
11. Migration guide from manual configuration

## Technical Approach

### Configuration File Structure

```yaml
# .minsky/config.yaml
version: 1
backends:
  default: github-issues

github:
  owner: ${GITHUB_OWNER} # Can reference env vars
  repo: ${GITHUB_REPO}
  token_source: environment # or 'file' or 'keychain'
  status_labels:
    TODO: "minsky:todo"
    IN_PROGRESS: "minsky:in-progress"
    IN_REVIEW: "minsky:in-review"
    DONE: "minsky:done"

preferences:
  auto_create_labels: true
  sync_existing_issues: false
  session_storage: ~/.local/state/minsky
  task_id_prefix: "TASK-"
```

### CLI Integration Examples

```bash
# Initialize repository configuration
minsky init --backend github-issues

# Configure default backend for repository
minsky config set backends.default github-issues

# Configure GitHub token source
minsky config set github.token_source environment

# View current configuration
minsky config list

# Remove configuration
minsky config unset backends.default
```

## Dependencies

- Secure credential storage library
- YAML/TOML parser for configuration
- OS keychain integration (optional)

## Estimated Effort

Large (8-12 hours)

## Notes

- Consider using existing config libraries (cosmiconfig pattern)
- Should integrate with VS Code workspace settings
- Future: Support for organization-level defaults
- Consider `.minsky/config.local.yaml` for user-specific overrides
- Should support both YAML and JSON formats for flexibility
- Team-shareable configuration files can be committed to repositories
- Configuration files eliminate the need for manual configuration on every command
