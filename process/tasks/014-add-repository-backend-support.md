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

1. [x] Create Repository Backend Interface

   - [x] Define `RepositoryBackend` interface in domain layer
   - [x] Extract current git operations into `LocalGitBackend` class
   - [x] Update existing code to use the new interface

2. [x] Implement Remote Git Backend

   - [x] Create `RemoteGitBackend` class implementing `RepositoryBackend`
   - [x] Implement core git remote operations (clone, push, pull)
   - [x] Add authentication handling for SSH and HTTPS

3. [x] Implement GitHub Backend

   - [x] Create `GitHubBackend` class extending `RemoteGitBackend`
   - [x] Add GitHub API integration
   - [x] Implement GitHub-specific repository operations
   - [x] Add GitHub authentication handling

4. [x] Update Session Management

   - [x] Add backend configuration to session settings
   - [x] Modify session creation to use configured backend
   - [x] Update session commands to support backend selection

5. [ ] Add Configuration Support

   - [x] Add repository backend options to session commands
   - [x] Add remote Git configuration options
   - [x] Add GitHub configuration options
   - [ ] Implement configuration validation
   - [ ] Add configuration documentation

6. [x] Update CLI Commands

   - [x] Add backend option to session commands
   - [x] Add Remote Git-specific options
   - [x] Add GitHub-specific options
   - [ ] Update command documentation

7. [ ] Add Tests

   - [x] Unit tests for backend interface
   - [x] Tests for LocalGitBackend
   - [x] Tests for RemoteGitBackend
   - [x] Tests for GitHubBackend
   - [ ] Integration tests for session creation with different backends
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

## Work Log

- 2025-05-10: Created repository backend interface in src/domain/repository/RepositoryBackend.ts with essential operations
- 2025-05-10: Implemented LocalGitBackend to match current functionality with the new interface
- 2025-05-10: Created RemoteGitBackend implementation with support for remote repository operations
- 2025-05-10: Added GitHubBackend with GitHub-specific features and API integration
- 2025-05-10: Developed index.ts with factory function to create appropriate backend based on configuration
- 2025-05-11: Fixed failing tests by updating testing approach to use Bun instead of Jest
- 2025-05-12: Fixed linting errors in the SessionDB implementation
- 2025-05-12: Enhanced session start command with additional options for remote repositories
- 2025-05-12: Added support for remote-specific options (auth method, clone depth) to session commands
- 2025-05-12: Updated GitService to pass remote configuration options to repository backends
- 2025-05-13: Updated session start command (start.ts) with new CLI options for repository backends
- 2025-05-13: Enhanced startSession.ts to properly handle remote repository options
- 2025-05-13: Modified GitService's clone method to support different backend types and their configurations
- 2025-05-13: Added backend type detection based on repository URL format

## Remaining Work

1. **Polishing and Bug Fixes**

   - [ ] Fix circular dependency issues in repository backend imports
   - [ ] Fix type issues with Result interface implementation in backends
   - [ ] Complete implementation of push/pull operations in GitHub backend
   - [ ] Ensure proper error handling for all backend operations
   - [ ] Standardize return types across all backends

2. **Testing**

   - [ ] Create comprehensive integration tests for each backend type
   - [ ] Test authentication methods with different repository sources
   - [ ] Test error handling scenarios (network failures, permission issues)
   - [ ] Create test fixtures for remote repository operations
   - [ ] Test backward compatibility with existing sessions

3. **Documentation**

   - [ ] Add comprehensive documentation in README for repository backends
   - [ ] Create examples for each backend type
   - [ ] Document configuration options and their default values
   - [ ] Add troubleshooting guide for common repository issues
   - [ ] Update CLI command help text with backend options

4. **Configuration and Migration**

   - [ ] Create migration utility for existing sessions to use explicit backend type
   - [ ] Add global configuration options for default repository backends
   - [ ] Implement backend auto-detection improvements
   - [ ] Add validation for configuration options

5. **Enhance GitHub Integration**

   - [ ] Complete GitHub API integration for PR creation
   - [ ] Add support for GitHub Enterprise
   - [ ] Implement token management and refresh
   - [ ] Add GitHub status reporting
