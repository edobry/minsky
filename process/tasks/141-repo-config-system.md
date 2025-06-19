# Task #141: Implement Repository Configuration System

## Status
TODO

## Priority
High

## Summary
Create a repository-level configuration system that allows users to set default task backend, authentication, and other settings per repository.

## Description
Currently, users need to:
- Manage `.env` files separately for GitHub tokens
- Specify `--backend` flag on every command
- Configure settings repeatedly across different repositories

This task implements a configuration system that stores repository-specific settings, making Minsky usage more seamless.

## Requirements

### Configuration Storage
- [ ] Implement `.minsky/config.yaml` (or similar) for repo-level config
- [ ] Support hierarchical configuration (user → repo → command-line)
- [ ] Secure storage for sensitive data (tokens, credentials)
- [ ] Migration path from environment variables

### Configuration Options
- [ ] Default task backend (markdown, json-file, github-issues)
- [ ] GitHub repository settings (owner, repo, token reference)
- [ ] Default labels for GitHub backend
- [ ] Task ID generation preferences
- [ ] Session storage preferences

### CLI Integration
- [ ] `minsky config init` - Interactive configuration setup
- [ ] `minsky config set <key> <value>` - Set configuration values
- [ ] `minsky config get <key>` - Get configuration values
- [ ] `minsky config list` - Show all configuration
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

## Acceptance Criteria
1. Users can run `minsky tasks list` without any flags after initial setup
2. Configuration is stored securely and portably
3. Team members can share non-sensitive configuration
4. Token/credential management follows security best practices
5. Backward compatibility with existing CLI flags

## Technical Approach
```yaml
# Example .minsky/config.yaml
version: 1
task_backend: github-issues
github:
  owner: ${GITHUB_OWNER}  # Can reference env vars
  repo: ${GITHUB_REPO}
  token_source: env:GITHUB_TOKEN  # Or keychain:github-token
  labels:
    TODO: "status:todo"
    IN-PROGRESS: "status:in-progress"
defaults:
  session_storage: ~/.local/state/minsky
  task_id_prefix: "TASK-"
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
