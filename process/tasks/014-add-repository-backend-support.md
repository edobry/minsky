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

2. [ ] Implement Remote Git Backend

   - [ ] Create `RemoteGitBackend` class implementing `RepositoryBackend`
   - [ ] Implement core git remote operations (clone, push, pull)
   - [ ] Add authentication handling for SSH and HTTPS

3. [x] Implement GitHub Backend

   - [x] Create `GitHubBackend` class implementing `RepositoryBackend`
   - [x] Add GitHub API integration
   - [x] Implement repository operations for GitHub
   - [x] Add GitHub authentication handling

4. [x] Update Session Management

   - [x] Add backend configuration to session settings
   - [x] Modify session creation to use configured backend
   - [x] Update session commands to support backend selection

5. [x] Add Configuration Support

   - [x] Add GitHub configuration options
   - [ ] Add Remote Git configuration options
   - [x] Implement configuration validation
   - [x] Add configuration documentation

6. [x] Update CLI Commands

   - [x] Add backend option to session commands
   - [ ] Add Remote Git-specific options
   - [x] Add GitHub-specific options
   - [x] Update command documentation

7. [x] Add Tests

   - [x] Unit tests for backend interface
   - [x] Tests for LocalGitBackend
   - [ ] Tests for RemoteGitBackend
   - [x] Tests for GitHubBackend
   - [x] Integration tests for session creation
   - [x] Test error handling scenarios

8. [x] Update Documentation
   - [x] Document backend configuration
   - [ ] Add Remote Git setup instructions
   - [x] Add GitHub setup instructions
   - [x] Update command reference
   - [x] Add examples for different backends

## Verification

- [x] Local git backend works exactly as before (backward compatibility)
- [ ] Remote Git backend successfully clones, pushes, and pulls repositories
- [x] GitHub backend successfully clones repositories
- [x] Session creation works with all backends
- [x] Configuration options are properly handled
- [x] Error scenarios are properly handled with clear messages
- [x] All tests pass
- [x] Documentation is complete and accurate

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

## Implementation Plan

### Phase 1: Remote Git Backend Implementation

1. Create the `RemoteGitBackend` class in `src/domain/remoteGitBackend.ts`:
   - Implement the `RepositoryBackend` interface
   - Support both SSH and HTTPS authentication 
   - Handle various remote git operations:
     - Cloning from remote URL
     - Pushing to remote
     - Pulling from remote
     - Handling branch operations

2. Update repository configuration types in `src/domain/repository.ts`:
   ```typescript
   export interface RemoteGitConfig extends RepositoryConfig {
     type: RepositoryBackendType.REMOTE;
     url: string;
     authType?: 'ssh' | 'https';
     token?: string; // For HTTPS auth
     branch?: string; // Branch to checkout
   }
   ```

3. Extend the factory function to support the remote backend:
   ```typescript
   export function createRepositoryBackend(config: RepositoryConfig): RepositoryBackend {
     switch (config.type) {
       case RepositoryBackendType.LOCAL:
         return new LocalGitBackend(config);
       case RepositoryBackendType.REMOTE:
         return new RemoteGitBackend(config as RemoteGitConfig);
       case RepositoryBackendType.GITHUB:
         return new GitHubBackend(config as GitHubConfig);
       default:
         throw new Error(`Unsupported repository backend type: ${config.type}`);
     }
   }
   ```

### Phase 2: CLI Updates for Remote Git

1. Add Remote Git-specific options to `src/commands/session/start.ts`:
   ```typescript
   .option('--backend <type>', 'Repository backend type (local, remote, github)', 'local')
   .option('--repo-url <url>', 'Remote repository URL (for remote backend)')
   .option('--branch <branch>', 'Branch to checkout (for remote backend)')
   .option('--auth-type <type>', 'Authentication type for remote repos (ssh, https)', 'ssh')
   .option('--token <token>', 'Authentication token (for https auth)')
   ```

2. Update the command handler to process Remote Git-specific options:
   ```typescript
   // Create repository config based on backend type
   let repoConfig: RepositoryConfig;
   
   switch (options.backend) {
     case 'remote':
       if (!options.repoUrl) {
         throw new Error('--repo-url is required for remote backend');
       }
       repoConfig = {
         type: RepositoryBackendType.REMOTE,
         url: options.repoUrl,
         authType: options.authType,
         token: options.token,
         branch: options.branch
       };
       break;
     // ...other cases
   }
   ```

### Phase 3: Authentication Handling

1. Implement authentication handling in `RemoteGitBackend`:
   - Support SSH key authentication (default)
   - Support HTTPS token authentication
   - Handle authentication failures gracefully

2. Add configuration options for authentication:
   ```typescript
   // In src/domain/config.ts
   export interface MinskyConfig {
     // ...existing fields
     remote?: {
       defaultAuthType?: 'ssh' | 'https';
       defaultToken?: string;
     };
   }
   ```

### Phase 4: Testing and Documentation

1. Add unit tests for `RemoteGitBackend`:
   - Test successful cloning from remote URLs
   - Test authentication with both SSH and HTTPS
   - Test error handling for various scenarios

2. Add integration tests for the full remote git workflow:
   - Test creating a session with a remote backend
   - Test the session lifecycle with remote operations

3. Update documentation:
   - Add Remote Git setup instructions
   - Document authentication options
   - Provide examples of using remote git repositories

### Implementation Details

The `RemoteGitBackend` class will be implemented as follows:

```typescript
// src/domain/remoteGitBackend.ts
import { RepositoryBackend, RemoteGitConfig, RepositoryBackendType } from './repository';
import { execGit } from '../utils/git';

export class RemoteGitBackend implements RepositoryBackend {
  protected config: RemoteGitConfig;
  private localPath: string;

  constructor(config: RemoteGitConfig) {
    this.config = {
      ...config,
      type: RepositoryBackendType.REMOTE,
    };
    this.localPath = '';
  }

  async clone(destination: string): Promise<void> {
    const { url, branch } = this.config;
    
    try {
      // Clone the repository
      await execGit(['clone', url, destination]);
      
      // Set the localPath
      this.localPath = destination;
      
      // Checkout the specific branch if provided
      if (branch) {
        await this.checkout(branch);
      }
    } catch (error) {
      throw new Error(`Failed to clone repository from ${url}: ${error.message}`);
    }
  }

  async getStatus(): Promise<any> {
    try {
      const output = await execGit(['status', '--porcelain'], { cwd: this.localPath });
      return { 
        clean: output.trim() === '',
        changes: output.split('\n').filter(line => line.trim() !== '')
      };
    } catch (error) {
      throw new Error(`Failed to get repository status: ${error.message}`);
    }
  }

  getPath(): string {
    return this.localPath;
  }

  async validate(): Promise<boolean> {
    try {
      await execGit(['remote', '-v'], { cwd: this.localPath });
      return true;
    } catch (error) {
      return false;
    }
  }

  async push(branch?: string): Promise<void> {
    const branchToPush = branch || 'HEAD';
    
    try {
      await execGit(['push', 'origin', branchToPush], { cwd: this.localPath });
    } catch (error) {
      throw new Error(`Failed to push to remote: ${error.message}`);
    }
  }

  async pull(branch?: string): Promise<void> {
    const branchToPull = branch || 'HEAD';
    
    try {
      await execGit(['pull', 'origin', branchToPull], { cwd: this.localPath });
    } catch (error) {
      throw new Error(`Failed to pull from remote: ${error.message}`);
    }
  }

  async createBranch(name: string): Promise<void> {
    try {
      await execGit(['checkout', '-b', name], { cwd: this.localPath });
    } catch (error) {
      throw new Error(`Failed to create branch ${name}: ${error.message}`);
    }
  }

  async checkout(branch: string): Promise<void> {
    try {
      await execGit(['checkout', branch], { cwd: this.localPath });
    } catch (error) {
      throw new Error(`Failed to checkout branch ${branch}: ${error.message}`);
    }
  }

  getConfig(): RemoteGitConfig {
    return this.config;
  }
}
```

### CLI Command Handler Updates

The session start command handler will be updated to handle Remote Git-specific options:

```typescript
// src/commands/session/start.ts

async function handleSessionStart(
  sessionArg: string | undefined,
  options: {
    repo?: string;
    repoUrl?: string;
    branch?: string;
    backend?: string;
    authType?: 'ssh' | 'https';
    token?: string;
    // ... other options
  }
) {
  // Determine the repository backend type
  const backendType = options.backend || 'local';
  
  // Create the appropriate repository configuration
  let repoConfig: RepositoryConfig;
  
  switch (backendType) {
    case 'local':
      const repoPath = options.repo
        ? options.repo
        : await resolveRepoPath({}).catch((err) => {
            throw new Error(
              `--repo is required (not in a git repo and no --repo provided): ${err.message}`
            );
          });
          
      repoConfig = {
        type: RepositoryBackendType.LOCAL,
        path: repoPath,
      };
      break;
      
    case 'remote':
      if (!options.repoUrl) {
        throw new Error('--repo-url is required for remote backend');
      }
      
      repoConfig = {
        type: RepositoryBackendType.REMOTE,
        url: options.repoUrl,
        authType: options.authType || 'ssh',
        token: options.token,
        branch: options.branch,
      };
      break;
      
    case 'github':
      // Existing GitHub backend handling
      break;
      
    default:
      throw new Error(`Unsupported backend type: ${backendType}`);
  }
  
  // Create the repository backend
  const backend = createRepositoryBackend(repoConfig);
  
  // Proceed with session creation using the backend
  // ...
}
```

## Work Log

- 2023-XX-XX: Created repository backend interface
- 2023-XX-XX: Implemented LocalGitBackend wrapping current git operations
- 2023-XX-XX: Implemented GitHubBackend for GitHub integration
- 2023-XX-XX: Updated session creation to support repository backends
- 2023-XX-XX: Added backend-specific CLI options to session commands
- 2023-XX-XX: Added tests for both backends and integration tests
- 2023-XX-XX: Updated documentation and CHANGELOG.md 
- 2025-05-09: Created detailed implementation plan for Remote Git backend support
