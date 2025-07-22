# Implement Repository Registry System

## Problem Statement

Currently, Minsky has no way to persist information about repositories it interacts with. Each operation that requires repository information must:

- Parse the full repository URL
- Fetch configurations directly from remotes
- Lacks a simple naming mechanism for referencing known repositories
- Cannot work offline without direct access to the repository

This creates several limitations:

1. Users working with multiple repositories must specify full URLs each time
2. Operations fail when offline or when connectivity to remotes is limited
3. No persistent caching of repository configurations
4. No way to quickly reference repositories by simple names/aliases

## Proposed Solution

Implement a "Repository Registry" system that:

1. Maintains a local database of repositories Minsky has interacted with
2. Caches repository configurations, project settings, and metadata locally
3. Allows referencing repositories by simple names/aliases
4. Supports offline operations using cached configurations
5. Automatically updates cached data when online

## Implementation Details

### Data Model

The repository registry should track:

- Repository URL (origin)
- Repository name/alias (user-defined friendly name)
- Local cached configuration
- Last sync timestamp
- Repository metadata (default branch, etc.)
- Project configuration
- Access credentials (if applicable, stored securely)

### Core Functionality

1. **Registration Commands**:

   - `minsky repo register <url> [--name <name>]` - Register a new repository
   - `minsky repo list` - List all registered repositories
   - `minsky repo info <name|url>` - Show details about a registered repository
   - `minsky repo forget <name|url>` - Remove a repository from registry

2. **Naming System**:

   - Allow custom naming/aliasing of repositories
   - Support referencing by name in all commands that accept repositories
   - Auto-generate names based on repo URLs when not specified

3. **Configuration Caching**:

   - Cache project configuration locally
   - Implement version tracking for cached configs
   - Support manually refreshing cached data
   - Add offline mode that explicitly uses only cached data

4. **Integration with Existing Commands**:
   - Enhance all commands that accept `--repo` parameter to work with registry names
   - Update session creation to leverage cached repository data
   - Enable offline operations for registered repositories

### Storage Design

1. **Storage Options**:

   - Leverage existing SessionDB backends (JSON, SQLite, PostgreSQL)
   - Implement proper schema for repository data
   - Add migration path for existing data

2. **Security Considerations**:
   - Implement secure storage for any sensitive repository information
   - Support for encrypted credentials if needed

## Technical Challenges

1. **Cache Invalidation**:

   - Determine when cached data needs refreshing
   - Balance between freshness and performance

2. **Offline Support**:

   - Clearly communicate when working with potentially stale data
   - Handle conflicts when reconnecting to network

3. **Authentication**:

   - Securely store and retrieve auth credentials
   - Support different auth methods (SSH keys, tokens, etc.)

4. **Migration Path**:
   - Provide way to migrate existing workflows to use registry

## Integration Points

1. **Session Management**:

   - Update session creation to leverage registry data
   - Allow sessions to specify repos by name

2. **Task System**:

   - Enable tasks to reference repos by name
   - Cache task-specific configuration

3. **Git Operations**:
   - Update git operations to work with registry information
   - Support offline operations where possible

## Acceptance Criteria

- [ ] Users can register repositories with custom names
- [ ] All Minsky commands that accept `--repo` parameter work with registry names
- [ ] Repository configurations are properly cached locally
- [ ] System works in offline mode with registered repositories
- [ ] Clear documentation on how to use the registry system
- [ ] Tests covering registry operations and integration with other systems
- [ ] Performance impact of registry operations is minimal

## Future Considerations

- Integration with organization-wide registries
- Remote registry synchronization
- Advanced repository grouping and tagging
- Repository access control integration
