# Minsky Configuration System Guide

## Overview

The Minsky configuration system provides a centralized, validated approach to managing all configuration aspects including storage backends, session databases, AI providers, and credentials. This guide covers configuration precedence, validation, migration, and best practices.

## Configuration Precedence Order

Minsky follows a strict configuration precedence order, where higher-priority sources override lower-priority ones:

### 1. Command Line Arguments (Highest Priority)
```bash
minsky tasks list --backend=github-issues
minsky sessions start --sessiondb-backend=sqlite
```

### 2. Environment Variables
```bash
export MINSKY_SESSIONDB_BACKEND=postgres
export MINSKY_SESSIONDB_POSTGRES_CONNECTION_STRING="postgresql://user:pass@localhost/minsky"
export MINSKY_AI_DEFAULT_PROVIDER=openai
```

### 3. User Configuration File (`~/.config/minsky/config.yaml`)
```yaml
version: 1
sessiondb:
  backend: sqlite
  sqlite:
    path: "~/.local/state/minsky/sessions.db"
ai:
  default_provider: anthropic
  providers:
    anthropic:
      credentials:
        source: environment
```

### 4. Repository Configuration File (`.minsky/config.yaml`)
```yaml
version: 1
backends:
  default: github-issues
  github-issues:
    owner: myorg
    repo: myrepo
```

### 5. Default Configuration (Lowest Priority)
Built-in defaults ensure Minsky works out-of-the-box without any configuration.

## Configuration Structure

### Repository Configuration (`.minsky/config.yaml`)

```yaml
version: 1
backends:
  default: "github-issues"  # or "json-file", "markdown"
  github-issues:
    owner: "your-org"
    repo: "your-repo"
  markdown:
    path: "./tasks"
  json-file:
    path: "./tasks.json"

sessiondb:
  backend: "sqlite"  # or "json", "postgres"
  sqlite:
    path: "~/.local/state/minsky/project-sessions.db"
  postgres:
    connection_string: "postgresql://user:pass@localhost:5432/minsky"
  base_dir: "~/.local/state/minsky"

ai:
  default_provider: "openai"  # or "anthropic", "google", "cohere", "mistral"
  providers:
    openai:
      credentials:
        source: "environment"  # or "file", "prompt"
        api_key_file: "~/.config/minsky/openai-key.txt"
      max_tokens: 4000
      temperature: 0.7
    anthropic:
      credentials:
        source: "file"
        api_key_file: "~/.config/minsky/anthropic-key.txt"
      max_tokens: 8000
      temperature: 0.5
```

### Global User Configuration (`~/.config/minsky/config.yaml`)

```yaml
version: 1
github:
  credentials:
    source: "environment"  # or "file", "prompt"
    token_file: "~/.config/minsky/github-token.txt"

sessiondb:
  backend: "sqlite"
  sqlite:
    path: "~/.local/state/minsky/global-sessions.db"

ai:
  default_provider: "anthropic"
  providers:
    anthropic:
      credentials:
        source: "environment"
      max_tokens: 8000
      temperature: 0.3

postgres:
  connection_string: "postgresql://user:pass@localhost:5432/minsky_global"
```

## Validation System

### Error Codes Reference

The configuration validation system provides specific error codes for different types of configuration issues:

#### Backend Validation Errors
- `MISSING_VERSION`: Configuration version is required
- `UNSUPPORTED_VERSION`: Configuration version not supported (expected: 1)
- `INVALID_BACKEND`: Invalid backend type specified
- `MISSING_GITHUB_OWNER`: GitHub owner required for github-issues backend
- `MISSING_GITHUB_REPO`: GitHub repository name required for github-issues backend

#### SessionDB Validation Errors
- `INVALID_SESSIONDB_BACKEND`: Invalid SessionDB backend (valid: json, sqlite, postgres)
- `MISSING_SQLITE_PATH`: SQLite database path not specified (warning)
- `MISSING_POSTGRES_CONNECTION_STRING`: PostgreSQL connection string required for postgres backend
- `EMPTY_CONNECTION_STRING`: Connection string cannot be empty
- `INVALID_CONNECTION_STRING_FORMAT`: Invalid PostgreSQL connection string format

#### Path Validation Errors
- `EMPTY_FILE_PATH`: File path cannot be empty
- `EMPTY_DIRECTORY_PATH`: Directory path cannot be empty
- `INVALID_FILE_PATH`: File path contains invalid characters
- `INVALID_DIRECTORY_PATH`: Directory path contains invalid characters
- `PATH_IS_DIRECTORY`: Path points to directory, expected file
- `PATH_IS_FILE`: Path points to file, expected directory

#### Path Validation Warnings
- `RELATIVE_FILE_PATH`: Relative file paths may cause issues across working directories
- `RELATIVE_DIRECTORY_PATH`: Relative directory paths may cause issues across working directories
- `UNRESOLVED_ENV_VARS`: Path contains environment variables that may not be resolved
- `INSUFFICIENT_PERMISSIONS`: File/directory exists but may not have read/write permissions
- `PARENT_DIR_NOT_WRITABLE`: Parent directory exists but is not writable
- `PARENT_DIR_MISSING`: Parent directory does not exist, will be created if needed
- `PATH_VALIDATION_ERROR`: Unable to validate path accessibility

#### AI Configuration Errors
- `INVALID_AI_PROVIDER`: Invalid AI provider (valid: openai, anthropic, google, cohere, mistral)
- `INVALID_CREDENTIAL_SOURCE`: Invalid credential source (valid: environment, file, prompt)
- `INCOMPLETE_FILE_CREDENTIALS`: Neither api_key nor api_key_file specified for file-based credentials (warning)
- `INVALID_MAX_TOKENS`: max_tokens must be a positive number
- `INVALID_TEMPERATURE`: temperature must be a number between 0 and 2

#### Security Warnings
- `PLAIN_TEXT_CREDENTIALS`: Consider using environment variables for database credentials instead of plain text

### Validation Examples

#### Valid Configuration
```yaml
version: 1
sessiondb:
  backend: sqlite
  sqlite:
    path: "/tmp/test.db"
ai:
  default_provider: openai
  providers:
    openai:
      credentials:
        source: environment
      max_tokens: 1000
      temperature: 0.7
```

#### Invalid Configuration (Multiple Errors)
```yaml
version: 2  # UNSUPPORTED_VERSION
sessiondb:
  backend: invalid-backend  # INVALID_SESSIONDB_BACKEND
  sqlite:
    path: ""  # EMPTY_FILE_PATH
ai:
  default_provider: invalid-provider  # INVALID_AI_PROVIDER
  providers:
    openai:
      temperature: 5.0  # INVALID_TEMPERATURE (must be 0-2)
```

## Migration Guide

### From Hardcoded Paths to Configuration

#### Before (Hardcoded)
```typescript
// ❌ Old approach - hardcoded paths
const sessionPath = `${process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state`}/minsky/sessions`;
const dbPath = `${process.env.HOME}/.local/state/minsky/session-db.json`;
```

#### After (Configuration-Driven)
```typescript
// ✅ New approach - configuration-driven
import { getSessionDir, getMinskyStateDir } from '../utils/paths';

const sessionPath = getSessionDir(sessionName);
const dbPath = path.join(getMinskyStateDir(), 'session-db.json');
```

### Environment Variable Migration

#### Before (Direct Access)
```typescript
// ❌ Old approach - direct environment access
const stateDir = process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state`;
const logMode = process.env.MINSKY_LOG_MODE || 'info';
```

#### After (Configuration Service)
```typescript
// ✅ New approach - configuration service
import { DefaultConfigurationService } from '../domain/configuration';

const configService = new DefaultConfigurationService();
const config = await configService.loadConfiguration(process.cwd());
const stateDir = getMinskyStateDir(); // Centralized utility
// Log mode still uses environment variables (appropriate for runtime config)
const logMode = process.env.MINSKY_LOG_MODE || 'info';
```

### Session Database Migration

#### Step 1: Update Configuration
```yaml
# Add to .minsky/config.yaml or ~/.config/minsky/config.yaml
sessiondb:
  backend: sqlite  # or json, postgres
  sqlite:
    path: "~/.local/state/minsky/sessions.db"
```

#### Step 2: Update Code
```typescript
// ❌ Before
const dbPath = './session-db.json';

// ✅ After
const config = await configService.loadConfiguration(workingDir);
const dbPath = config.sessiondb?.sqlite?.path || getDefaultJsonDbPath();
```

### AI Provider Migration

#### Step 1: Update Configuration
```yaml
# Add AI configuration
ai:
  default_provider: openai
  providers:
    openai:
      credentials:
        source: environment  # Reads from OPENAI_API_KEY
      max_tokens: 4000
      temperature: 0.7
```

#### Step 2: Update Environment Variables
```bash
# Set API keys as environment variables
export OPENAI_API_KEY="your-api-key"
export ANTHROPIC_API_KEY="your-anthropic-key"
```

## Best Practices

### 1. Configuration Organization

**Repository-Specific Configuration** (`.minsky/config.yaml`):
- Task backends (GitHub Issues, JSON files, Markdown)
- Project-specific AI settings
- Project-specific session database settings

**User Global Configuration** (`~/.config/minsky/config.yaml`):
- Default AI providers and credentials
- Global session database settings
- GitHub credentials

### 2. Security Best Practices

**✅ Do:**
- Use environment variables for API keys and credentials
- Use `source: environment` for credential configuration
- Store connection strings in environment variables

**❌ Don't:**
- Put API keys directly in configuration files
- Commit credential files to version control
- Use plain text passwords in connection strings

### 3. Path Configuration

**✅ Recommended:**
```yaml
sessiondb:
  sqlite:
    path: "~/.local/state/minsky/project-sessions.db"  # Use ~/ for home directory
```

**⚠️ Use with caution:**
```yaml
sessiondb:
  sqlite:
    path: "./sessions.db"  # Relative paths may cause issues
```

### 4. Environment Variable Patterns

**Runtime Configuration** (Keep as environment variables):
```bash
export MINSKY_LOG_MODE=debug
export NODE_ENV=development
```

**Application Configuration** (Use configuration files):
```yaml
ai:
  default_provider: openai
sessiondb:
  backend: sqlite
```

### 5. Validation and Error Handling

Always validate configuration before use:

```typescript
const configService = new DefaultConfigurationService();
const config = await configService.loadConfiguration(workingDir);

// Validate repository configuration
const repoValidation = configService.validateRepositoryConfig(config);
if (!repoValidation.valid) {
  console.error('Configuration errors:', repoValidation.errors);
  process.exit(1);
}

// Validate global user configuration  
const userValidation = configService.validateGlobalUserConfig(config);
if (!userValidation.valid) {
  console.error('User configuration errors:', userValidation.errors);
}
```

## Troubleshooting

### Common Issues

#### 1. Invalid Backend Configuration
```
Error: INVALID_BACKEND - Invalid backend: invalid-backend. Valid options: markdown, json-file, github-issues
```
**Solution:** Use a valid backend type in your configuration.

#### 2. Missing GitHub Credentials
```
Error: MISSING_GITHUB_REPO - GitHub repository name is required for github-issues backend
```
**Solution:** Add GitHub repository configuration:
```yaml
backends:
  github-issues:
    owner: "your-org"
    repo: "your-repo"
```

#### 3. Path Permission Issues
```
Warning: INSUFFICIENT_PERMISSIONS - File exists but may not have read/write permissions
```
**Solution:** Check file permissions or use a different path:
```bash
chmod 644 ~/.local/state/minsky/sessions.db
# or
mkdir -p ~/.local/state/minsky && chmod 755 ~/.local/state/minsky
```

#### 4. Connection String Format Issues
```
Error: INVALID_CONNECTION_STRING_FORMAT - Invalid PostgreSQL connection string format
```
**Solution:** Use proper PostgreSQL connection string format:
```yaml
postgres:
  connection_string: "postgresql://username:password@host:port/database"
```

### Debug Configuration Loading

Enable debug logging to troubleshoot configuration issues:

```bash
export MINSKY_LOG_MODE=debug
minsky tasks list  # Will show detailed configuration loading info
```

## Advanced Configuration

### Custom Configuration Paths

Override default configuration paths using environment variables:

```bash
export MINSKY_CONFIG_DIR="/custom/config/path"
export MINSKY_STATE_DIR="/custom/state/path"
```

### Multiple Environment Setup

Use different configurations for different environments:

```bash
# Development
export MINSKY_CONFIG_DIR="./config/dev"

# Production  
export MINSKY_CONFIG_DIR="./config/prod"

# Testing
export MINSKY_CONFIG_DIR="./config/test"
```

### Configuration Validation in CI/CD

Validate configuration in your CI/CD pipeline:

```bash
# In your CI script
minsky config validate
if [ $? -ne 0 ]; then
  echo "Configuration validation failed"
  exit 1
fi
```

## Configuration Schema Reference

For the complete TypeScript interfaces and schema definitions, see:
- `src/domain/configuration/types.ts` - Core configuration interfaces
- `src/domain/configuration/configuration-service.ts` - Validation implementation
- `src/domain/configuration/configuration-service.test.ts` - Validation examples and test cases 
