# Restructure configuration to colocate credentials with their components

## Status

IN-PROGRESS

## Priority

MEDIUM

## Description

Reorganize configuration structure to group credentials with their respective components (GitHub, AI providers) instead of separating them into a separate credentials section. This addresses poor configuration locality where settings for the same component are scattered across multiple sections.

**✅ CORE INFRASTRUCTURE COMPLETE**: Schema, types, core services, and configuration files have been successfully restructured. The new component-based credential structure is functional.

## Problem Statement

Currently, the configuration structure splits related settings across multiple sections:

**Current Structure Issues:**

```yaml
credentials:
  github:
    source: "environment"
    token: "GITHUB_TOKEN"
  ai:
    openai:
      source: "environment"
    anthropic:
      source: "environment"

ai:
  providers:
    openai: # openai settings separated from credentials
      enabled: true
      models: []
    anthropic: # anthropic settings separated from credentials
      enabled: true
      models: []
```

**Problems:**

- **Poor Locality**: OpenAI credentials and settings are in different sections
- **Difficult Configuration**: Users must edit multiple sections for one component
- **Maintenance Overhead**: Adding new providers requires touching multiple places
- **Confusing Structure**: Not intuitive where to find/set component settings

## Proposed New Structure

**After Restructuring:**

```yaml
github:
  credentials:
    source: "environment"
    token: "GITHUB_TOKEN"
  # Future: other github settings can go here

ai:
  providers:
    openai:
      credentials:
        source: "environment"
      enabled: true
      models: []
    anthropic:
      credentials:
        source: "environment"
      enabled: true
      models: []
    # ... other providers
```

**Benefits:**

- **Component Locality**: All settings for a component in one place
- **Easier Configuration**: Users only need to edit one section per component
- **Better Encapsulation**: Each component owns its complete configuration
- **Follows Common Patterns**: Like Docker Compose, Kubernetes, etc.
- **Extensible**: Easy to add new GitHub or AI provider settings

## Requirements

### Core Changes

1. **Update Configuration Schema** ✅ COMPLETE

   - ✅ Move `credentials.github.*` → `github.credentials.*`
   - ✅ Move `credentials.ai.*` → `ai.providers.*.credentials.*`
   - ✅ Remove top-level `credentials` section

2. **Update Environment Variable Mappings** ✅ COMPLETE

   - ✅ Change `credentials.github.token: "GITHUB_TOKEN"` → `github.credentials.token: "GITHUB_TOKEN"`
   - ✅ Add AI provider credential mappings as needed

3. **Update Code References** ✅ COMPLETE

   - ✅ Fix all `config.credentials.github` references → `config.github.credentials`
   - ✅ Fix all `config.credentials.ai.*` references → `config.ai.providers.*.credentials`
   - ✅ Update validation schemas and type definitions

4. **Migration Strategy** ⚠️ MODIFIED
   - ❌ Provide backward compatibility during transition (SKIPPED - breaking change accepted)
   - ❌ Create migration utility for existing configurations (SKIPPED)
   - ⏳ Document migration path for users (TODO)

### Implementation Plan

**Phase 1: Schema & Types** ✅ COMPLETE

- ✅ Update TypeScript configuration types
- ✅ Update configuration validation schemas
- ✅ Update default.yaml and custom-environment-variables.yaml

**Phase 2: Code Updates** ✅ COMPLETE

- ✅ Update all references in credential-manager.ts
- ✅ Update all references in configuration-service.ts
- ✅ Update all references in config-generator.ts
- ⏳ Update all references in config-loader.ts (needs testing)
- ✅ Update AI configuration code

**Phase 3: Migration & Compatibility** ⚠️ SKIPPED

- ❌ Create configuration migration utility (SKIPPED)
- ❌ Add backward compatibility layer (SKIPPED - breaking change accepted)
- ⏳ Update documentation and examples (TODO)
- ⏳ Test with existing configurations (TODO)

**Phase 4: Cleanup** 🚧 IN-PROGRESS

- ⏳ Update remaining failing tests (IN-PROGRESS)
- ⏳ Update config list/show output formatting (TODO)
- ⏳ Final testing and validation (TODO)

### Files to Update

**Configuration Files:** ✅ COMPLETE

- ✅ `config/default.yaml`
- ✅ `config/custom-environment-variables.yaml`

**Core Implementation:** ✅ COMPLETE

- ✅ `src/domain/configuration/credential-manager.ts`
- ✅ `src/domain/configuration/configuration-service.ts`
- ✅ `src/domain/configuration/config-generator.ts`
- ⏳ `src/domain/configuration/config-loader.ts` (needs test verification)
- ✅ `src/domain/ai/config-service.ts`

**Types & Schemas:** ✅ COMPLETE

- ✅ Configuration TypeScript types
- ✅ Validation schemas
- ✅ Command parameter definitions

**Tests:** 🚧 IN-PROGRESS

- ✅ Configuration service tests updated
- ⏳ SessionDB configuration tests (19/41 failing - need updates)
- ⏳ Other test files (TBD)

## Success Criteria

- ✅ All GitHub settings are under `github.credentials.*`
- ✅ All AI provider credentials are under `ai.providers.*.credentials.*`
- ✅ No top-level `credentials` section remains
- ✅ Core functionality works with new structure
- ✅ Configuration is more intuitive and easier to manage
- ❌ Backward compatibility provided during transition (SKIPPED)
- ❌ Migration utility successfully converts existing configs (SKIPPED)
- ⏳ Documentation updated to reflect new structure
- ⏳ All tests pass with new configuration structure

## Breaking Changes

This is a **breaking change** that will require:

- ✅ Migration of existing configuration files
- ⏳ Updates to documentation
- ⏳ Version bump to indicate breaking change
- ⏳ Clear migration instructions for users

## Migration Example

**Before:**

```yaml
credentials:
  github:
    token: "ghp_xxx"
  ai:
    openai:
      source: "environment"

ai:
  providers:
    openai:
      enabled: true
```

**After:**

```yaml
github:
  credentials:
    token: "ghp_xxx"

ai:
  providers:
    openai:
      credentials:
        source: "environment"
      enabled: true
```

## Current Progress Status

### ✅ Completed Phases
- **Phase 1 & 2**: Core infrastructure completely restructured and functional
- **Configuration Files**: New format implemented
- **Core Services**: All credential/config services updated
- **Basic Testing**: Configuration service tests passing

### 🚧 Current Focus: Test Updates
- **Next**: Fix SessionDB configuration tests (19 failing tests)
- **Then**: Update any other failing test suites
- **Then**: CLI integration testing

### ⏳ Remaining Work
- Test suite updates for new structure
- Documentation updates
- CLI command updates
- Final integration testing

**Core restructuring is complete and functional. Working on comprehensive test coverage.**
