# Task #014: Add Repository Backend Support for Remote Git Repositories

## Context

Currently, Minsky implicitly uses a local git repository as its backend for session management. To support more flexible workflows and remote repository integration, we need to introduce an explicit concept of repository backends. This will allow us to support different repository sources, including remote git repositories like GitHub, GitLab, and general remote git URLs.

## Requirements

1. **Repository Backend Interface**

   - Create an abstract interface for repository operations
   - Support multiple backend implementations:
     - Local Git (default, current implementation)
     - Remote Git (new, for any remote Git URL)
     - GitHub (specific implementation for GitHub repositories)
   - Operations to support:
     - Clone repository
     - Get repository status
     - Get repository path
     - Validate repository
     - Push changes to origin
     - Pull changes from origin

2. **Session Integration**

   - Add repository backend configuration to session configuration
   - Default to "local" backend for backward compatibility
   - Support "remote" backend option for general remote git repositories
   - Support "github" backend option for GitHub-specific features
   - Update session creation to use the configured backend
   - Ensure session workflows function as the "origin" of the local session workspace

3. **Remote Git Backend Implementation**

   - Implement a generic Remote Git repository backend
   - Support cloning from any valid git URL during session creation
   - Support pushing to and pulling from the remote repository
   - Handle authentication via SSH keys and HTTPS tokens
   - Support standard git remote operations

4. **GitHub Backend Implementation**

   - Implement GitHub-specific repository backend extending the Remote Git backend
   - Add GitHub API integration for additional GitHub-specific features
   - Support authentication and access token management
   - Support GitHub-specific operations like PR creation via API

5. **CLI Updates**

   - Add repository backend option to relevant commands:
     ```
     minsky session start --backend remote --repo-url https://github.com/org/repo.git
     minsky session start --backend github --github-repo org/repo
     ```
   - Support Remote Git-specific options:
     - `--repo-url`: Remote repository URL
     - `--branch`: Branch to checkout
   - Support GitHub-specific options:
     - `--github-token`: GitHub access token
     - `--github-owner`: Repository owner
     - `--github-repo`: Repository name

6. **Configuration**

   - Add Remote Git configuration options to Minsky config:
     - Default authentication settings
     - Default branch name pattern
   - Add GitHub configuration options to Minsky config:
     - Default GitHub token
     - Default repository owner
     - Other GitHub-specific settings

7. **Error Handling**
   - Handle Remote Git errors gracefully
   - Handle GitHub API errors gracefully
   - Provide clear error messages for:
     - Authentication failures
     - Repository not found
     - Network issues
     - Permission issues

## Implementation Steps

1. [ ] Create Repository Backend Interface

   - [ ] Define `RepositoryBackend` interface in domain layer
   - [ ] Extract current git operations into `LocalGitBackend` class
   - [ ] Update existing code to use the new interface

2. [ ] Implement Remote Git Backend

   - [ ] Create `RemoteGitBackend` class implementing `RepositoryBackend`
   - [ ] Implement core git remote operations (clone, push, pull)
   - [ ] Add authentication handling for SSH and HTTPS

3. [ ] Implement GitHub Backend

   - [ ] Create `GitHubBackend` class extending `RemoteGitBackend`
   - [ ] Add GitHub API integration
   - [ ] Implement GitHub-specific repository operations
   - [ ] Add GitHub authentication handling

4. [ ] Update Session Management

   - [ ] Add backend configuration to session settings
   - [ ] Modify session creation to use configured backend
   - [ ] Update session commands to support backend selection

5. [ ] Add Configuration Support

   - [ ] Add Remote Git configuration options
   - [ ] Add GitHub configuration options
   - [ ] Implement configuration validation
   - [ ] Add configuration documentation

6. [ ] Update CLI Commands

   - [ ] Add backend option to session commands
   - [ ] Add Remote Git-specific options
   - [ ] Add GitHub-specific options
   - [ ] Update command documentation

7. [ ] Add Tests

   - [ ] Unit tests for backend interface
   - [ ] Tests for LocalGitBackend
   - [ ] Tests for RemoteGitBackend
   - [ ] Tests for GitHubBackend
   - [ ] Integration tests for session creation
   - [ ] Test error handling scenarios

8. [ ] Update Documentation
   - [ ] Document backend configuration
   - [ ] Add Remote Git setup instructions
   - [ ] Add GitHub setup instructions
   - [ ] Update command reference
   - [ ] Add examples for different backends

## Verification

- [ ] Local git backend works exactly as before (backward compatibility)
- [ ] Remote Git backend successfully clones, pushes, and pulls repositories
- [ ] GitHub backend successfully interacts with GitHub repositories
- [ ] Session creation works with all backends
- [ ] Configuration options are properly handled
- [ ] Error scenarios are properly handled with clear messages
- [ ] All tests pass
- [ ] Documentation is complete and accurate

## Dependencies

- Git command-line access
- Network connectivity for remote operations
- GitHub API access for GitHub backend
- Existing session management code

## Notes

- Consider other specific implementations for GitLab, Bitbucket, etc.
- Ensure backward compatibility for existing sessions
- Consider migration path for existing sessions to explicit backend configuration
- Prioritize the Remote Git backend for general use cases
