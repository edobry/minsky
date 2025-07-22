# Implement External Task Database for Metadata Storage

## Context

## Context

Currently, task metadata (such as merge commit information) is stored within the task specification files using YAML frontmatter. This approach has several limitations:

1. **Backend Limitations**: Different task backends (Markdown, GitHub Issues) have different capabilities for storing metadata.
2. **Synchronization Issues**: Task #304 attempted to fix synchronization between special workspace and main workspace, but issues persist where task files exist but commands like `tasks get` and `tasks spec` can't find them.
3. **Limited Metadata Support**: Complex metadata like merge commit information, relationships, and dependencies are difficult to store consistently across backends.
4. **No Central Source of Truth**: Each backend has its own storage mechanism, leading to inconsistencies.

The session database implementation (Task #091) successfully addressed similar issues by providing multiple backend options (JSON, SQLite, PostgreSQL) while maintaining a consistent interface. We should implement a similar approach for task metadata.

## Requirements

1. **Create TaskDatabase Interface**:
   - Design a database interface similar to SessionDB that works alongside existing task backends
   - Support storing task metadata separately from task content
   - Ensure consistent metadata access regardless of the task backend used

2. **Multiple Backend Support**:
   - JSON file backend (default for backward compatibility)
   - SQLite backend (better performance, ACID transactions)
   - PostgreSQL backend (team environments, concurrent access)

3. **Metadata Storage**:
   - Store merge commit information (hash, date, author)
   - Support for task relationships (parent-child, dependencies)
   - Additional metadata fields (priority, tags, estimates)

4. **Integration with Existing Task System**:
   - Maintain backward compatibility with existing task backends
   - Enhance TaskService to use both backend and metadata database
   - Provide migration utilities for existing task metadata

5. **Configuration System**:
   - Allow configuration of task database backend (similar to SessionDB)
   - Support environment variable overrides
   - Repository-level and user-level configuration

## Implementation Approach

1. **Reuse Existing Architecture**:
   - Leverage the `DatabaseStorage<T, S>` interface from SessionDB
   - Adapt existing storage backends (JsonFileStorage, SqliteStorage, PostgresStorage)
   - Follow the same configuration patterns as SessionDB

2. **Task Metadata Schema**:
   - Define a comprehensive schema for task metadata
   - Include fields for merge information, relationships, and custom metadata
   - Ensure schema extensibility for future metadata types

3. **TaskService Enhancement**:
   - Modify TaskService to use both task backend and metadata database
   - Update methods like `setTaskMetadata` to store in the external database
   - Ensure backward compatibility with existing code

4. **Synchronization Logic**:
   - Implement synchronization between task backends and metadata database
   - Handle conflicts and data integrity issues
   - Provide tools for manual synchronization when needed

5. **Migration Utilities**:
   - Create tools to migrate existing metadata from task files to the database
   - Support bidirectional synchronization during transition period
   - Provide data validation and repair utilities

## Related Tasks

- Task #304: Fix special workspace auto-commit sync issue
- Task #129: Implement Local DB Tasks Backend
- Task #091: Enhance SessionDB with Multiple Backend Support
- Task #235: Task Metadata Architecture Research and Design

This task will build on the successful architecture of the SessionDB implementation while addressing the specific needs of task metadata storage.

## Requirements

## Solution

## Notes
