# Vector Storage Fallback Behavior Guide

## Overview

Minsky's similarity search commands automatically handle cases where vector storage is not available by falling back to lexical search methods. This guide explains the fallback behavior, what users can expect, and how to identify when fallbacks are occurring.

## Vector Storage Support by Backend

| Backend               | Vector Storage    | Fallback Method          | User Experience              |
| --------------------- | ----------------- | ------------------------ | ---------------------------- |
| PostgreSQL + pgvector | ✅ Full Support   | N/A (no fallback needed) | Semantic similarity search   |
| SQLite                | ❌ Not Supported  | Lexical text search      | Basic keyword matching       |
| JSON                  | ❌ Not Supported  | Lexical text search      | Basic keyword matching       |
| Memory (Test)         | ⚡ In-Memory Only | N/A (temporary storage)  | Full features during session |

## Fallback Behavior Details

### When Fallback Occurs

Fallback to lexical search automatically occurs when:

1. **Backend doesn't support vector storage** (SQLite, JSON)
2. **PostgreSQL missing pgvector extension**
3. **Vector storage initialization fails**
4. **Embedding generation is disabled**

### What Changes During Fallback

| Feature           | With Vector Storage                     | Fallback Behavior                 |
| ----------------- | --------------------------------------- | --------------------------------- |
| **Search Method** | Semantic similarity using AI embeddings | Basic text/keyword matching       |
| **Understanding** | Contextual meaning and intent           | Literal string matching only      |
| **Ranking**       | Similarity scores (0.0-1.0)             | Simple relevance scoring          |
| **Synonyms**      | Understands related concepts            | Exact word matches only           |
| **Context**       | Considers full context and meaning      | Limited to surface-level matching |

## User Experience Examples

### With Vector Storage (PostgreSQL + pgvector)

```bash
$ minsky tasks search "user authentication"
Found 5 similar tasks:

  mt#123 - Implement JWT authentication system (score: 0.89)
  mt#145 - Add OAuth2 provider integration (score: 0.82)
  mt#167 - User login session management (score: 0.78)
  mt#189 - Password reset functionality (score: 0.71)
  mt#201 - Two-factor authentication setup (score: 0.69)

Search completed using semantic similarity (vector storage).
```

**Behavior:**

- ✅ Finds conceptually related tasks even with different wording
- ✅ Understands "authentication" includes JWT, OAuth2, login, etc.
- ✅ Provides meaningful similarity scores
- ✅ Ranks by semantic relevance

### With Fallback (SQLite/JSON)

```bash
$ minsky tasks search "user authentication"
⚠️  Vector storage not supported by current backend, falling back to lexical search

Found 3 matching tasks:

  mt#123 - Implement JWT authentication system
  mt#167 - User login session management
  mt#189 - Password reset functionality

Search completed using lexical matching.
```

**Behavior:**

- ⚠️ Warning message indicates fallback mode
- 🔍 Only finds tasks containing exact words "user" or "authentication"
- ❌ Misses related concepts (JWT, OAuth2) without explicit keywords
- ❌ No similarity scores provided
- ✅ Still provides useful results for exact matches

## Fallback Warning Messages

### Console Output

Users will see clear indicators when fallback occurs:

```bash
# Rule similarity search fallback
$ minsky rules search "error handling"
⚠️  Vector storage not supported by current backend, falling back to lexical search

# Task similarity search fallback
$ minsky tasks similar mt#123
⚠️  Vector storage not supported by current backend, using lexical comparison

# Initial service startup (debug logs)
DEBUG: Current persistence provider does not support vector storage, using memory backend
```

### Log Messages

```bash
# Enable debug logging to see detailed fallback information
MINSKY_LOG_LEVEL=debug minsky tasks search "query"

# Example debug output:
[WARN] Vector storage not supported by current backend, falling back to lexical search
[DEBUG] Current persistence provider does not support vector storage, using memory backend
[DEBUG] Provider returned null for vector storage, using memory backend
```

## Performance Implications

### Vector Storage Performance

```bash
# Typical performance with PostgreSQL + pgvector
$ time minsky tasks search "authentication patterns"
Found 12 similar tasks.
real    0m0.241s    # Fast semantic search
user    0m0.078s
sys     0m0.032s
```

### Fallback Performance

```bash
# Typical performance with lexical fallback
$ time minsky tasks search "authentication patterns"
⚠️  Vector storage not supported, falling back to lexical search
Found 4 matching tasks.
real    0m0.089s    # Faster but less comprehensive
user    0m0.045s
sys     0m0.021s
```

**Performance Characteristics:**

- **Vector Search**: Slower but more comprehensive and intelligent
- **Lexical Fallback**: Faster but limited scope and accuracy
- **Memory Usage**: Lower during fallback (no embeddings loaded)

## Detecting Current Configuration

### Check Vector Storage Status

```bash
# Check current backend capabilities
minsky config show persistence

# Example output for PostgreSQL:
persistence:
  backend: postgres
  capabilities:
    vectorStorage: true    # ✅ Vector storage available
    transactions: true
    jsonb: true

# Example output for SQLite:
persistence:
  backend: sqlite
  capabilities:
    vectorStorage: false   # ❌ Vector storage not available
    transactions: true
    jsonb: false
```

### Verify pgvector Extension

```bash
# For PostgreSQL backends, verify pgvector is installed
psql "postgresql://user:pass@host:port/db" \
  -c "SELECT * FROM pg_extension WHERE extname = 'vector';"

# Expected output if pgvector is available:
  extname | extowner | extnamespace | extrelocatable | extversion
 ---------+----------+--------------+----------------+------------
  vector  |       10 |         2200 | f              | 0.5.1
```

## Improving Search Results During Fallback

### Search Strategy Tips

When using lexical fallback, optimize your search queries:

**Better Lexical Search Queries:**

```bash
# ❌ Less effective with fallback
minsky tasks search "auth flow"

# ✅ More effective with fallback
minsky tasks search "authentication login"
minsky tasks search "auth OR login OR credential"
minsky tasks search "user AND password"
```

**Include More Keywords:**

```bash
# ❌ Limited results
minsky rules search "error"

# ✅ Better coverage
minsky rules search "error handling exception catch"
```

### Task/Rule Content Optimization

Structure your task titles and content to work well with lexical search:

```markdown
# ❌ Less discoverable with lexical search

mt#123: Implement auth system

# ✅ More discoverable with lexical search

mt#123: Implement user authentication login system with JWT tokens

# Include relevant keywords in description

Implement user authentication system including:

- JWT token generation and validation
- Login/logout functionality
- Session management
- Password hashing and verification
```

## Migration Path to Enable Vector Storage

### Quick Migration

If you're currently using SQLite and want vector storage capabilities:

```bash
# 1. Set up PostgreSQL with pgvector (one-time setup)
# See: docs/postgresql-vector-storage-setup.md

# 2. Update configuration to use PostgreSQL
export MINSKY_PERSISTENCE_BACKEND=postgres
export MINSKY_PERSISTENCE_POSTGRES_CONNECTION_STRING="postgresql://user:pass@localhost/minsky"

# 3. Initialize embeddings for existing content
minsky tasks index-embeddings --reindex
minsky rules index-embeddings --reindex

# 4. Test vector storage is working
minsky tasks search "your search query"  # Should not show fallback warning
```

### Gradual Migration

For teams wanting to test vector storage:

```bash
# 1. Set up PostgreSQL for testing
# 2. Create repository-specific configuration
echo 'persistence:
  backend: postgres
  postgres:
    connectionString: "postgresql://test:pass@localhost/minsky_test"' > .minsky/config.yaml

# 3. Test in specific repositories while keeping SQLite globally
minsky tasks search "test query"  # Uses PostgreSQL in this repo
cd ../other-project && minsky tasks search "test"  # Uses global SQLite
```

## Troubleshooting Fallback Issues

### Common Problems

#### Unexpected Fallback with PostgreSQL

**Symptoms**: Getting fallback warnings despite PostgreSQL configuration

**Debug Steps**:

```bash
# 1. Verify configuration is loaded
minsky config show persistence

# 2. Test PostgreSQL connection
psql "your-connection-string" -c "SELECT 1;"

# 3. Verify pgvector extension
psql "your-connection-string" -c "SELECT * FROM pg_extension WHERE extname = 'vector';"

# 4. Check Minsky logs
MINSKY_LOG_LEVEL=debug minsky tasks search "test" 2>&1 | grep -i vector
```

#### Poor Fallback Results

**Symptoms**: Lexical search returns few or irrelevant results

**Solutions**:

1. **Use more specific keywords** in search queries
2. **Include synonyms** in search terms
3. **Improve task/rule content** with relevant keywords
4. **Consider migrating to PostgreSQL** for better search quality

#### Performance Issues During Fallback

**Symptoms**: Slow lexical search performance

**Solutions**:

1. **Reduce search scope** with more specific terms
2. **Use filters** to limit search space
3. **Optimize task content** structure for text search
4. **Consider database indexing** improvements

## Best Practices

### For Users with Vector Storage

- **Use natural language queries**: "Find tasks about user authentication workflows"
- **Be descriptive**: The semantic search understands context and meaning
- **Trust similarity scores**: Higher scores indicate better semantic matches

### For Users with Fallback

- **Use specific keywords**: Include exact terms you expect to find
- **Try multiple variations**: Search for synonyms and related terms
- **Structure content well**: Use clear, keyword-rich task titles and descriptions
- **Consider upgrading**: PostgreSQL + pgvector provides significantly better search

### For Teams/Organizations

- **Standardize on PostgreSQL**: Consistent vector storage across all projects
- **Train users on search strategies**: Different approaches for vector vs lexical search
- **Monitor search usage**: Identify teams that would benefit from vector storage
- **Plan migration**: Gradual rollout of PostgreSQL + pgvector setup

## Related Documentation

- [PostgreSQL Vector Storage Setup Guide](postgresql-vector-storage-setup.md) - Complete installation and configuration
- [Configuration Guide](configuration-guide.md) - Persistence backend configuration
- [Multi-Backend User Guide](multi-backend-user-guide.md) - Working with different task backends
- [SessionDB Migration Guide](sessiondb-migration-guide.md) - Backend migration procedures
