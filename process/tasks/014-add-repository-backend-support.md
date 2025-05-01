# Task #014: Add Repository Backend Support

## Context

Currently, Minsky implicitly uses a local git repository as its backend for session management. To support more flexible workflows and remote repository integration, we need to introduce an explicit concept of repository backends. This will allow us to support different repository sources, starting with GitHub integration.

## Requirements

1. **Repository Backend Interface**
   - Create an abstract interface for repository operations
   - Support multiple backend implementations:
     - Local Git (default, current implementation)
     - GitHub (new)
   - Operations to support:
     - Clone repository
     - Get repository status
     - Get repository path
     - Validate repository

2. **Session Integration**
   - Add repository backend configuration to session configuration
   - Default to "local" backend for backward compatibility
   - Support "github" backend option
   - Update session creation to use the configured backend

3. **GitHub Backend Implementation**
   - Implement GitHub repository backend
   - Support cloning from GitHub during session creation
   - Handle GitHub-specific repository operations
   - Support authentication and access token management

4. **CLI Updates**
   - Add repository backend option to relevant commands:
     ```
     minsky session create --backend github
     ```
   - Support GitHub-specific options:
     - `--github-token`: GitHub access token
     - `--github-owner`: Repository owner
     - `--github-repo`: Repository name

5. **Configuration**
   - Add GitHub configuration options to Minsky config:
     - Default GitHub token
     - Default repository owner
     - Other GitHub-specific settings

6. **Error Handling**
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

2. [x] Implement GitHub Backend
   - [x] Create `GitHubBackend` class implementing `RepositoryBackend`
   - [x] Add GitHub API integration
   - [x] Implement repository operations for GitHub
   - [x] Add GitHub authentication handling

3. [x] Update Session Management
   - [x] Add backend configuration to session settings
   - [x] Modify session creation to use configured backend
   - [x] Update session commands to support backend selection

4. [x] Add Configuration Support
   - [x] Add GitHub configuration options
   - [x] Implement configuration validation
   - [x] Add configuration documentation

5. [x] Update CLI Commands
   - [x] Add backend option to session commands
   - [x] Add GitHub-specific options
   - [x] Update command documentation

6. [x] Add Tests
   - [x] Unit tests for backend interface
   - [x] Tests for LocalGitBackend
   - [x] Tests for GitHubBackend
   - [x] Integration tests for session creation
   - [x] Test error handling scenarios

7. [x] Update Documentation
   - [x] Document backend configuration
   - [x] Add GitHub setup instructions
   - [x] Update command reference
   - [x] Add examples for different backends

## Verification

- [x] Local git backend works exactly as before (backward compatibility)
- [x] GitHub backend successfully clones repositories
- [x] Session creation works with both backends
- [x] Configuration options are properly handled
- [x] Error scenarios are properly handled with clear messages
- [x] All tests pass
- [x] Documentation is complete and accurate

## Dependencies

- GitHub API access
- GitHub authentication mechanism
- Existing session management code

## Notes

- Consider future backend implementations (e.g., GitLab, Bitbucket)
- Ensure backward compatibility for existing sessions
- Consider migration path for existing sessions to explicit backend configuration 

## Work Log

- 2023-XX-XX: Created repository backend interface
- 2023-XX-XX: Implemented LocalGitBackend wrapping current git operations
- 2023-XX-XX: Implemented GitHubBackend for GitHub integration
- 2023-XX-XX: Updated session creation to support repository backends
- 2023-XX-XX: Added backend-specific CLI options to session commands
- 2023-XX-XX: Added tests for both backends and integration tests
- 2023-XX-XX: Updated documentation and CHANGELOG.md 
