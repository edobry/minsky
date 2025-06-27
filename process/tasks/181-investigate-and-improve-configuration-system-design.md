# Task #181: Investigate and improve configuration system design

## Status

BACKLOG

## Priority

MEDIUM

## Context

During implementation of the AI completion backend (Task #160), we discovered that Minsky's configuration system has over-engineered patterns that don't follow typical configuration system conventions. The current system forces unnecessary complexity on users and developers.

## Problem Statement

The current Minsky configuration system has several issues:

1. **Unnecessary `source` field**: The AI credentials configuration requires a `source` field (`environment`, `file`, `prompt`) that's redundant with the natural precedence hierarchy already implemented in the code.

2. **Over-engineered schema**: The configuration schema forces explicit source declarations when standard configuration systems check all sources in precedence order automatically.

3. **Inconsistent with established patterns**: Most configuration systems (Docker, Kubernetes, Node.js apps, etc.) automatically check environment variables first, then config files, without requiring users to specify which source they're using.

4. **Unnecessary cognitive load**: Users have to understand and specify the `source` field when the system could determine this automatically.

## Current Implementation Analysis

The code already implements a proper 5-level precedence hierarchy:

1. CLI flags
2. Environment variables
3. Global user config (`~/.config/minsky/config.yaml`)
4. Repository config
5. Defaults

However, the schema in `src/domain/configuration/types.ts` forces users to explicitly declare the source of their credentials, which contradicts this automatic precedence system.

## Requirements

### 1. Schema Simplification

- [ ] Remove the unnecessary `source` field from AI credentials configuration
- [ ] Allow credentials to be specified directly without source declarations

### 2. Automatic Source Detection

- [ ] Implement automatic precedence checking for AI credentials
- [ ] Environment variables should be checked first (e.g., `OPENAI_API_KEY`)
- [ ] Config file values should be used if env vars not present
- [ ] Prompt for missing credentials only as last resort

### 3. Configuration Schema Updates

- [ ] Update `AICredentialsConfig` type to remove `source` field
- [ ] Update related validation logic
- [ ] Update configuration loading logic to handle simplified schema

### 4. User Experience Improvements

- [ ] Simplify configuration examples in documentation
- [ ] Provide clear error messages when credentials are missing

### 5. Testing and Validation

- [ ] Add tests for automatic credential detection
- [ ] Test precedence order (env vars > config file > prompt)
- [ ] Test error handling for missing credentials

## Implementation Steps

### Phase 1: Analysis and Design

- [ ] Audit all uses of the `source` field in the codebase
- [ ] Document current configuration patterns across the system
- [ ] Identify other over-engineered configuration patterns
- [ ] Design simplified configuration schema

### Phase 2: Schema Simplification

- [ ] Update `AICredentialsConfig` type definition
- [ ] Remove `source` field requirements
- [ ] Update validation schemas (Zod, etc.)
- [ ] Update configuration loading logic

### Phase 3: Automatic Detection Implementation

- [ ] Implement automatic environment variable detection
- [ ] Update config file parsing to handle simplified format
- [ ] Implement fallback to prompting for missing credentials
- [ ] Add proper error handling and user feedback

### Phase 4: Testing and Documentation

- [ ] Add comprehensive tests for new configuration behavior
- [ ] Update configuration documentation
- [ ] Update all configuration examples

## Technical Considerations

### Error Handling

- Clear error messages when credentials are missing
- Helpful suggestions for where to add credentials
- Graceful handling of malformed configuration

### Security

- Ensure environment variables are properly handled
- Avoid logging sensitive credential information
- Maintain secure credential storage practices

## Verification Criteria

### Functional Requirements

- [ ] AI credentials can be configured via environment variables without `source` field
- [ ] AI credentials can be configured via config file without `source` field
- [ ] Precedence order works correctly (env vars > config file > prompt)
- [ ] Error messages are clear and helpful when credentials are missing

### Code Quality

- [ ] Configuration loading logic is simplified and easier to understand
- [ ] No unnecessary complexity in configuration schemas
- [ ] Proper test coverage for all configuration scenarios
- [ ] Documentation is updated and accurate

### User Experience

- [ ] Configuration setup is simpler for new users
- [ ] Error messages guide users to correct solutions
- [ ] Configuration examples are clear and minimal

## Success Criteria

1. **Simplified Configuration**: Users can configure AI credentials by simply setting environment variables or adding values to config files without specifying source
2. **Maintained Functionality**: All configuration functionality works correctly
3. **Better UX**: Configuration setup is more intuitive and follows standard patterns
4. **Clean Codebase**: Configuration logic is simpler and more maintainable
5. **Comprehensive Testing**: All configuration scenarios are properly tested

## References

- Task #160: Add AI Completion Backend (where this issue was discovered)
- `src/domain/configuration/config-loader.ts`: Current configuration loading implementation
- `src/domain/configuration/types.ts`: Current configuration type definitions
- Standard configuration patterns from Docker, Kubernetes, Node.js ecosystem
