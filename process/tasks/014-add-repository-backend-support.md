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

### Phase 1: Repository Backend Interface Refinement

1. Create or update the core interface in `src/domain/repository.ts`:
   - Define the `RepositoryBackendType` enum (LOCAL, REMOTE, GITHUB)
   - Define strongly typed interfaces for repository operations
   - Create repository configuration types with clear validation rules
   - Define specific return types for all methods (no `any` types)

   ```typescript
   // Example of improved typing for repository operations
   export interface RepositoryStatus {
     clean: boolean;
     changes: string[];
     branch: string;
     tracking?: string;
   }

   export interface RepositoryBackend {
     // Core repository operations with well-defined return types
     clone(destination: string): Promise<void>;
     getStatus(): Promise<RepositoryStatus>;
     getPath(): string;
     validate(): Promise<{ valid: boolean; issues?: string[] }>;
     
     // Remote operations
     push(branch?: string): Promise<void>;
     pull(branch?: string): Promise<void>;
     
     // Branch operations
     createBranch(name: string): Promise<void>;
     checkout(branch: string): Promise<void>;
     
     // Configuration
     getConfig(): RepositoryConfig;
   }
   ```

2. Create a common repository operations utility in `src/utils/repository-utils.ts`:
   - Implement caching mechanism for repository metadata
   - Define cache invalidation strategies
   - Add helper methods for common operations

   ```typescript
   // Example of repository metadata cache
   export class RepositoryMetadataCache {
     private static instance: RepositoryMetadataCache;
     private cache: Map<string, { data: any; timestamp: number }> = new Map();
     private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes
     
     private constructor() {}
     
     static getInstance(): RepositoryMetadataCache {
       if (!RepositoryMetadataCache.instance) {
         RepositoryMetadataCache.instance = new RepositoryMetadataCache();
       }
       return RepositoryMetadataCache.instance;
     }
     
     async get<T>(key: string, fetcher: () => Promise<T>, ttl = this.DEFAULT_TTL): Promise<T> {
       const cacheEntry = this.cache.get(key);
       const now = Date.now();
       
       if (cacheEntry && now - cacheEntry.timestamp < ttl) {
         return cacheEntry.data as T;
       }
       
       const data = await fetcher();
       this.cache.set(key, { data, timestamp: now });
       return data;
     }
     
     invalidate(key: string): void {
       this.cache.delete(key);
     }
     
     invalidateAll(): void {
       this.cache.clear();
     }
   }
   ```

### Phase 2: Remote Git Backend Implementation

1. Implement `src/domain/remoteGitBackend.ts` with system git authentication:
   - Rely on the system's git configuration for authentication
   - Support remote repository operations via git CLI
   - Implement proper error handling with domain-specific errors
   - Utilize the repository metadata cache for performance

   ```typescript
   // src/domain/remoteGitBackend.ts
   import { RepositoryBackend, RepositoryConfig, RepositoryStatus, RepositoryBackendType } from './repository';
   import { execGit } from '../utils/git';
   import { RepositoryMetadataCache } from '../utils/repository-utils';

   export class RepositoryError extends Error {
     constructor(message: string, public readonly cause?: Error) {
       super(message);
       this.name = 'RepositoryError';
     }
   }

   export class RemoteGitBackend implements RepositoryBackend {
     protected config: RepositoryConfig;
     private localPath: string;
     private cache: RepositoryMetadataCache;

     constructor(config: RepositoryConfig) {
       this.config = {
         ...config,
         type: RepositoryBackendType.REMOTE,
       };
       this.localPath = '';
       this.cache = RepositoryMetadataCache.getInstance();
     }

     async clone(destination: string): Promise<void> {
       try {
         // Clone using system git config for authentication
         await execGit(['clone', this.config.url, destination]);
         this.localPath = destination;
         
         // Checkout specific branch if provided
         if (this.config.branch) {
           await this.checkout(this.config.branch);
         }
       } catch (error) {
         throw new RepositoryError(
           `Failed to clone repository from ${this.config.url}`,
           error instanceof Error ? error : undefined
         );
       }
     }

     async getStatus(): Promise<RepositoryStatus> {
       const cacheKey = `status-${this.localPath}`;
       
       return this.cache.get(cacheKey, async () => {
         try {
           const statusOutput = await execGit(['status', '--porcelain'], { cwd: this.localPath });
           const branchOutput = await execGit(['branch', '--show-current'], { cwd: this.localPath });
           const trackingOutput = await execGit(['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: this.localPath }).catch(() => '');
           
           return {
             clean: statusOutput.trim() === '',
             changes: statusOutput.split('\n').filter(line => line.trim() !== ''),
             branch: branchOutput.trim(),
             tracking: trackingOutput.trim() || undefined
           };
         } catch (error) {
           throw new RepositoryError(
             'Failed to get repository status',
             error instanceof Error ? error : undefined
           );
         }
       }, 30000); // 30-second cache
     }

     // Other methods with similar improvements...

     async validate(): Promise<{ valid: boolean; issues?: string[] }> {
       try {
         const issues: string[] = [];
         
         // Check if directory exists and is a git repository
         try {
           await execGit(['rev-parse', '--git-dir'], { cwd: this.localPath });
         } catch (error) {
           issues.push('Not a valid git repository');
           return { valid: false, issues };
         }
         
         // Check if remote is accessible
         try {
           await execGit(['ls-remote', '--exit-code', 'origin'], { cwd: this.localPath });
         } catch (error) {
           issues.push('Remote origin is not accessible');
         }
         
         return { valid: issues.length === 0, issues: issues.length > 0 ? issues : undefined };
       } catch (error) {
         return { 
           valid: false, 
           issues: ['Failed to validate repository: ' + (error instanceof Error ? error.message : String(error))]
         };
       }
     }
   }
   ```

### Phase 3: Unified CLI Interface

1. Update `src/commands/session/start.ts` with consistent repository options:
   - Use the `--repo` option for both local paths and remote URLs
   - Add type detection logic to determine if a repo is local or remote
   - Maintain backward compatibility for existing options
   - Apply consistent naming patterns

   ```typescript
   // src/commands/session/start.ts
   return new Command("start")
     .description("Start a new session with a repository")
     .argument("[session]", "Session identifier (optional if --task is provided)")
     .option("-r, --repo <repo>", "Repository URL or local path")
     .option("-b, --branch <branch>", "Branch to checkout (for remote repositories)")
     .option("--backend <type>", "Repository backend type (local, remote, github)", "auto")
     .option("--github-owner <owner>", "GitHub repository owner (for github backend)")
     .option("--github-repo <repo>", "GitHub repository name (for github backend)")
     .option("-t, --task <taskId>", "Task ID to associate with the session")
     .option("-q, --quiet", "Output only the session directory path")
     .option("--no-status-update", "Skip automatic task status update to IN-PROGRESS")
     .action(async (sessionArg, options) => {
       try {
         // Check if current directory is already within a session
         // ... existing code ...
         
         // Auto-detect repository type if not explicitly specified
         let backendType = options.backend;
         let repoIdentifier = options.repo;
         
         // Auto-detect backend type
         if (backendType === "auto" && repoIdentifier) {
           if (repoIdentifier.startsWith("http://") || 
               repoIdentifier.startsWith("https://") || 
               repoIdentifier.startsWith("git@")) {
             backendType = "remote";
             
             // Further detect if it's specifically GitHub
             if (repoIdentifier.includes("github.com")) {
               backendType = "github";
             }
           } else {
             backendType = "local";
           }
         }
         
         // Create appropriate repository configuration
         let repoConfig: RepositoryConfig;
         
         switch (backendType) {
           case "local":
             // ... existing local repo handling
             break;
           case "remote":
             repoConfig = {
               type: RepositoryBackendType.REMOTE,
               url: repoIdentifier,
               branch: options.branch
             };
             break;
           case "github":
             // ... existing GitHub handling
             break;
           default:
             throw new Error(`Unsupported backend type: ${backendType}`);
         }
         
         // ... continue with session creation
       } catch (error) {
         // ... error handling
       }
     });
   ```

### Phase 4: Migration Strategy for Existing Sessions

1. Add migration support in `src/domain/session.ts`:
   - Ensure backward compatibility with existing sessions
   - Add version field to session configuration
   - Implement automatic migration for older session formats
   - Provide utilities for upgrading session configurations

   ```typescript
   // Update session configuration
   export interface SessionConfig {
     version: number; // Add version field
     name: string;
     repo: RepositoryConfig;
     // ... other fields
   }
   
   // Migration function for older session configs
   export function migrateSessionConfig(oldConfig: any): SessionConfig {
     if (oldConfig.version >= 2) {
       return oldConfig as SessionConfig; // Already migrated
     }
     
     // Migrate from version 1 (implicit local backend) to version 2
     if (!oldConfig.version) {
       return {
         version: 2,
         name: oldConfig.name,
         repo: {
           type: RepositoryBackendType.LOCAL,
           path: oldConfig.repoPath || oldConfig.repoUrl
         },
         // Copy other fields from old config
         ...Object.fromEntries(
           Object.entries(oldConfig).filter(([key]) => 
             !['repoPath', 'repoUrl', 'version'].includes(key)
           )
         )
       };
     }
     
     throw new Error(`Unknown session config version: ${oldConfig.version}`);
   }
   
   // When loading sessions, apply migration
   export async function loadSession(sessionName: string): Promise<SessionConfig> {
     const rawConfig = await sessionDb.getSession(sessionName);
     return migrateSessionConfig(rawConfig);
   }
   ```

### Phase 5: Testing Strategy

1. Comprehensive testing with proper isolation:
   - Unit tests for backend interfaces with mocked git operations
   - Integration tests for the complete workflow
   - Test coverage for migration and backward compatibility
   - Test for specific error scenarios

   ```typescript
   // Example test file structure
   // src/domain/__tests__/remoteGitBackend.test.ts
   
   describe('RemoteGitBackend', () => {
     // Mock git execution to avoid actual git operations
     beforeEach(() => {
       jest.spyOn(gitUtils, 'execGit').mockImplementation(async (args, options) => {
         // Return mock data based on command
         if (args[0] === 'clone') return '';
         if (args[0] === 'status') return '';
         // ... other commands
         return '';
       });
     });
     
     it('should clone remote repository', async () => {
       // ... test implementation
     });
     
     it('should use system git config for authentication', async () => {
       // ... test implementation
     });
     
     it('should handle network errors gracefully', async () => {
       // ... test implementation 
     });
     
     // ... other tests
   });
   ```

### Implementation Sequence

1. Phase 1: Repository Backend Interface Refinement
   - Update the interface with proper typing
   - Implement caching mechanism
   - Update existing LocalGitBackend to use the refined interface

2. Phase 3: Unified CLI Interface
   - Update CLI options for consistency
   - Implement auto-detection logic
   - Update help documentation

3. Phase 4: Migration Strategy
   - Implement session configuration versioning
   - Add migration utilities
   - Test backward compatibility

4. Phase 2: Remote Git Backend Implementation
   - Implement RemoteGitBackend with system git authentication
   - Integrate with caching system
   - Add proper error handling

5. Extend GitHub Backend
   - Update GitHubBackend to extend RemoteGitBackend
   - Ensure GitHub-specific features work correctly

6. Final Testing and Documentation
   - End-to-end testing of the complete workflow
   - Update documentation with new options and features

## Work Log

- 2023-XX-XX: Created repository backend interface
- 2023-XX-XX: Implemented LocalGitBackend wrapping current git operations
- 2023-XX-XX: Implemented GitHubBackend for GitHub integration
- 2023-XX-XX: Updated session creation to support repository backends
- 2023-XX-XX: Added backend-specific CLI options to session commands
- 2023-XX-XX: Added tests for both backends and integration tests
- 2023-XX-XX: Updated documentation and CHANGELOG.md 
- 2025-05-09: Created detailed implementation plan for Remote Git backend support
- 2025-05-09: Revised implementation plan based on senior engineer feedback
