# Task #181: Investigate and improve configuration system design

## Status

ACTIVE

## Priority

HIGH

## Context

During implementation of the AI completion backend (Task #160), we discovered that Minsky's configuration system has over-engineered patterns that don't follow typical configuration system conventions. The current system forces unnecessary complexity on users and developers.

**UPDATE (2025-01-27)**: Task #224 completed credential colocating restructuring, moving from `credentials.ai.*` to `ai.providers.*.credentials.*`. However, the core issue of requiring explicit `source` field declarations remains unresolved and is still causing user friction.

## Problem Statement

The current Minsky configuration system has several issues:

1. **Unnecessary `source` field**: Both AI and GitHub credentials configuration require a `source` field (`environment`, `file`, `prompt`) that's redundant with the natural precedence hierarchy already implemented in the code.

2. **Inconsistent systems**: The AI config service (`src/domain/ai/config-service.ts`) already implements automatic environment variable checking (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.), but the main configuration system still requires explicit `source` declarations.

3. **Over-engineered schema**: The configuration schema forces explicit source declarations when standard configuration systems check all sources in precedence order automatically.

4. **Inconsistent with established patterns**: Most configuration systems (Docker, Kubernetes, Node.js apps, etc.) automatically check environment variables first, then config files, without requiring users to specify which source they're using.

5. **Unnecessary cognitive load**: Users have to understand and specify the `source` field when the system could determine this automatically.

## Current Implementation Analysis

The code already implements a proper 5-level precedence hierarchy:

1. CLI flags
2. Environment variables  
3. Global user config (`~/.config/minsky/config.yaml`)
4. Repository config (`.minsky/config.yaml`)
5. Defaults

However, there are **two separate systems**:
- **Main config system**: Requires explicit `source` declarations in schema
- **AI config service**: Can read environment variables automatically (`OPENAI_API_KEY`, etc.) but operates separately

**Key Issue**: The AI config service should use the same logic as the general config system, not bespoke logic.

## Updated Requirements

### 1. Unify Configuration Systems

- [ ] **CRITICAL**: Integrate AI credential detection into the main configuration system
- [ ] Remove the separate AI config service's bespoke credential resolution
- [ ] Ensure both GitHub and AI credentials use the same unified system

### 2. Schema Simplification  

- [ ] Remove the unnecessary `source` field from both AI and GitHub credentials configuration
- [ ] Allow credentials to be specified directly without source declarations
- [ ] Update configuration validation to handle optional credentials gracefully

### 3. Automatic Source Detection in Main Config System

- [ ] Implement automatic precedence checking for AI credentials in config-loader
- [ ] Add environment variable mappings for AI providers in `custom-environment-variables.yaml`
- [ ] Environment variables should be checked first (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)
- [ ] Config file values should be used if env vars not present
- [ ] Prompt for missing credentials only as last resort

### 4. Configuration Schema Updates

- [ ] Update `AIProviderConfig` and `GitHubConfig` types to remove `source` field
- [ ] Update related validation logic in `configuration-service.ts`
- [ ] Update configuration loading logic in `config-loader.ts` to handle simplified schema
- [ ] Update default configurations to remove explicit `source` declarations

### 5. User Experience Improvements

- [ ] Simplify configuration examples in documentation  
- [ ] Provide clear error messages when credentials are missing
- [ ] Update all configuration examples across documentation

### 6. Testing and Validation

- [ ] Add tests for automatic credential detection in main config system
- [ ] Test precedence order (env vars > config file > prompt)
- [ ] Test error handling for missing credentials
- [ ] Ensure AI config service integration works correctly

## Implementation Steps

### Phase 1: Analysis and Unified Design

- [ ] **Audit current dual systems**: Document how main config system vs AI config service differ
- [ ] **Design unified approach**: Specify how AI credentials will be integrated into main config system
- [ ] **Environment variable mapping**: Plan standard AI provider environment variables
- [ ] **Schema simplification design**: Plan removal of `source` field from all credential configs

### Phase 2: Main Configuration System Enhancement

- [ ] **Add AI environment variable mappings** to `custom-environment-variables.yaml`
- [ ] **Update config-loader.ts** to handle AI credentials automatically like GitHub credentials
- [ ] **Remove source field requirements** from configuration types
- [ ] **Update validation logic** to handle simplified schema

### Phase 3: Schema and Type Updates

- [ ] **Update `AIProviderConfig` and `GitHubConfig`** types to remove `source` field
- [ ] **Update configuration validation** schemas and error handling
- [ ] **Update default configurations** to remove explicit `source` declarations
- [ ] **Ensure backward compatibility** during transition

### Phase 4: AI Config Service Integration

- [ ] **Modify AI config service** to use main configuration system instead of bespoke logic
- [ ] **Remove duplicate credential resolution** from AI config service
- [ ] **Test integration** to ensure AI providers work correctly

### Phase 5: Testing and Documentation

- [ ] **Add comprehensive tests** for unified configuration behavior
- [ ] **Update configuration documentation** to reflect simplified approach
- [ ] **Update all configuration examples** across codebase and docs
- [ ] **Verify user experience** improvements

## Technical Considerations

### Environment Variable Standards

Map standard AI provider environment variables:
- `OPENAI_API_KEY` → `ai.providers.openai.credentials.api_key`
- `ANTHROPIC_API_KEY` → `ai.providers.anthropic.credentials.api_key`
- `GOOGLE_AI_API_KEY` → `ai.providers.google.credentials.api_key`
- `COHERE_API_KEY` → `ai.providers.cohere.credentials.api_key`
- `MISTRAL_API_KEY` → `ai.providers.mistral.credentials.api_key`

### Error Handling

- Clear error messages when credentials are missing
- Helpful suggestions for where to add credentials (environment variables vs config files)
- Graceful handling of malformed configuration

### Security

- Ensure environment variables are properly handled
- Avoid logging sensitive credential information  
- Maintain secure credential storage practices

### Migration Strategy

- Support both old (with `source`) and new (without `source`) configurations during transition
- Provide clear migration guidance for users
- Log deprecation warnings for old configuration format

## Updated Verification Criteria

### Functional Requirements

- [ ] **Unified system**: AI credentials use same logic as GitHub credentials (main config system)
- [ ] **Environment variable detection**: AI credentials auto-detected from standard env vars
- [ ] **Config file support**: AI credentials read from config files without `source` field
- [ ] **Precedence order**: Works correctly (env vars > config file > prompt)
- [ ] **Error messages**: Clear and helpful when credentials are missing

### Code Quality  

- [ ] **Single system**: No duplicate credential resolution logic between systems
- [ ] **Simplified schemas**: No unnecessary `source` field complexity
- [ ] **Proper test coverage**: All configuration scenarios tested
- [ ] **Documentation accuracy**: All examples updated and correct

### User Experience

- [ ] **Simplified setup**: Users configure AI credentials via env vars or config files only
- [ ] **Intuitive errors**: Error messages guide users to correct solutions
- [ ] **Standard patterns**: Follows common configuration system conventions

## Success Criteria

1. **Unified Configuration System**: AI config service uses main configuration system, no bespoke logic
2. **Simplified Configuration**: Users configure credentials via environment variables or config files without specifying source
3. **Maintained Functionality**: All existing configuration functionality works correctly  
4. **Better UX**: Configuration setup follows standard patterns and is more intuitive
5. **Clean Codebase**: Single configuration system, no duplicate logic
6. **Comprehensive Testing**: All configuration scenarios properly tested

## References

- **Task #160**: Add AI Completion Backend (where this issue was discovered)
- **Task #224**: Restructure configuration to colocate credentials (COMPLETED)
- `src/domain/configuration/config-loader.ts`: Main configuration loading implementation
- `src/domain/configuration/types.ts`: Configuration type definitions  
- `src/domain/ai/config-service.ts`: Current AI config service (to be integrated)
- `config/custom-environment-variables.yaml`: Environment variable mappings
- Standard configuration patterns from Docker, Kubernetes, Node.js ecosystem
