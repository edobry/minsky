# Restructure configuration to colocate credentials with their components

## Status

BACKLOG

## Priority

MEDIUM

## Description

Reorganize configuration structure to group credentials with their respective components (GitHub, AI providers) instead of separating them into a separate credentials section. This addresses poor configuration locality where settings for the same component are scattered across multiple sections.

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
  default_provider: null
  providers:
    openai:
      credentials:
        source: "environment"
      enabled: true
      default_model: null
      base_url: null
      models: []
      max_tokens: null
      temperature: null
    anthropic:
      credentials:
        source: "environment"
      enabled: true
      default_model: null
      base_url: null
      models: []
      max_tokens: null
      temperature: null
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

1. **Update Configuration Schema**

   - Move `credentials.github.*` → `github.credentials.*`
   - Move `credentials.ai.*` → `ai.providers.*.credentials.*`
   - Remove top-level `credentials` section

2. **Update Environment Variable Mappings**

   - Change `credentials.github.token: "GITHUB_TOKEN"` → `github.credentials.token: "GITHUB_TOKEN"`
   - Add AI provider credential mappings as needed

3. **Update Code References**

   - Fix all `config.credentials.github` references → `config.github.credentials`
   - Fix all `config.credentials.ai.*` references → `config.ai.providers.*.credentials`
   - Update validation schemas and type definitions

4. **Migration Strategy**
   - Provide backward compatibility during transition
   - Create migration utility for existing configurations
   - Document migration path for users

### Implementation Plan

**Phase 1: Schema & Types**

- [ ] Update TypeScript configuration types
- [ ] Update configuration validation schemas
- [ ] Update default.yaml and custom-environment-variables.yaml

**Phase 2: Code Updates**

- [ ] Update all references in credential-manager.ts
- [ ] Update all references in configuration-service.ts
- [ ] Update all references in config-generator.ts
- [ ] Update all references in config-loader.ts
- [ ] Update AI configuration code

**Phase 3: Migration & Compatibility**

- [ ] Create configuration migration utility
- [ ] Add backward compatibility layer (temporary)
- [ ] Update documentation and examples
- [ ] Test with existing configurations

**Phase 4: Cleanup**

- [ ] Remove backward compatibility layer (breaking change)
- [ ] Update config list/show output formatting
- [ ] Final testing and validation

### Files to Update

**Configuration Files:**

- `config/default.yaml`
- `config/custom-environment-variables.yaml`

**Core Implementation:**

- `src/domain/configuration/credential-manager.ts`
- `src/domain/configuration/configuration-service.ts`
- `src/domain/configuration/config-generator.ts`
- `src/domain/configuration/config-loader.ts`
- `src/domain/ai/config-service.ts`

**Types & Schemas:**

- Configuration TypeScript types
- Validation schemas
- Command parameter definitions

## Success Criteria

- [ ] All GitHub settings are under `github.credentials.*`
- [ ] All AI provider credentials are under `ai.providers.*.credentials.*`
- [ ] No top-level `credentials` section remains
- [ ] All existing functionality works unchanged
- [ ] Configuration is more intuitive and easier to manage
- [ ] Backward compatibility provided during transition
- [ ] Migration utility successfully converts existing configs
- [ ] Documentation updated to reflect new structure
- [ ] All tests pass with new configuration structure

## Breaking Changes

This is a **breaking change** that will require:

- Migration of existing configuration files
- Updates to documentation
- Version bump to indicate breaking change
- Clear migration instructions for users

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
