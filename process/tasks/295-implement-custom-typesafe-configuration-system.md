# Task #295: Implement Custom Type-Safe Configuration System

## Status

TODO

## Priority

HIGH

## Context

After extensive work with `node-config` in Task #181, we've determined that existing configuration libraries don't meet our specific requirements for hierarchical configuration with proper TypeScript support. We need a custom solution that provides:

1. **Type Safety**: Full TypeScript support with Zod schema validation
2. **Hierarchical Overrides**: Multiple configuration sources with clear precedence
3. **Flexibility**: Support for different configuration patterns across different domains
4. **Simplicity**: No complex directory conventions or magic file naming

## Problem Statement

Current `node-config` implementation has several limitations:

1. **Poor TypeScript Integration**: Requires manual type assertions and lacks compile-time safety
2. **Inflexible Hierarchy**: Fixed directory structure and file naming conventions
3. **Complex Environment Variable Mapping**: Requires separate YAML files for environment variable mapping
4. **Limited Validation**: Basic validation without rich error messages
5. **Monolithic Structure**: All configuration in single files, making it hard to organize by domain

## Requirements

### **Functional Requirements**

1. **Type Safety**
   - Full TypeScript integration with Zod schemas
   - Compile-time type checking for all configuration access
   - Runtime validation with detailed error messages
   - Schema-derived TypeScript types

2. **Configuration Hierarchy** (in precedence order)
   - Environment variables (highest priority)
   - Per-user system-level overrides (`~/.config/minsky/`)
   - Per-project overrides (committed to git repo)
   - Default values (lowest priority)

3. **Domain Organization**
   - Separate schemas for different configuration domains
   - Composable configuration sections
   - Clear separation of concerns

4. **Developer Experience**
   - Simple import and usage: `config.github.token`
   - Auto-completion and type checking in IDEs
   - Clear error messages for validation failures
   - Easy testing with configuration overrides

### **Non-Functional Requirements**

1. **Performance**: Fast configuration loading and access
2. **Reliability**: Robust error handling and validation
3. **Maintainability**: Clear code organization and documentation
4. **Testability**: Easy to mock and override for testing

## Implementation Plan

### **Phase 1: Requirements Analysis**

#### **Task 1.1: Reverse Engineer Current Configuration Requirements**

Analyze existing configuration usage to determine:

1. **Configuration Domains**: Identify all configuration sections currently in use
   - Extract from current `config/default.yaml`
   - Analyze all `config.get()` calls in codebase
   - Review Task #181 for historical configuration requirements
   - Document environment variables currently used

2. **Configuration Patterns**: Understand current usage patterns
   - Simple values (strings, numbers, booleans)
   - Nested objects
   - Arrays and lists
   - Conditional configuration based on environment
   - Credential handling patterns

3. **Override Requirements**: Document what needs to be overridable at different levels
   - **Environment Variables**: Credentials, runtime-specific settings
   - **User Overrides**: Personal preferences, development settings
   - **Project Overrides**: Environment-specific settings, feature flags
   - **Defaults**: Base configuration, fallback values

4. **Validation Requirements**: Determine what validation is needed
   - Required vs optional fields
   - Type validation (string, number, enum, etc.)
   - Format validation (URLs, file paths, etc.)
   - Cross-field validation and dependencies

#### **Task 1.2: Design Configuration Architecture**

Based on requirements analysis, design:

1. **Schema Organization**
   - Domain-specific schema files
   - Composable schema patterns
   - Shared utility schemas

2. **Loading Strategy**
   - Configuration file discovery
   - Merge strategy for hierarchical overrides
   - Environment variable mapping
   - Caching and performance optimization

3. **API Design**
   - TypeScript interface for configuration access
   - Validation function signatures
   - Error handling patterns
   - Testing utilities

### **Phase 2: Core Implementation**

#### **Task 2.1: Implement Schema Infrastructure**

1. **Base Schema Types**
   ```typescript
   // src/domain/configuration/schemas/base.ts
   export const baseSchemas = {
     filePath: z.string().min(1),
     url: z.string().url(),
     port: z.number().int().min(1).max(65535),
     // ... other common patterns
   };
   ```

2. **Domain Schemas**
   ```typescript
   // src/domain/configuration/schemas/github.ts
   export const githubSchema = z.object({
     token: z.string().min(1).optional(),
     organization: z.string().optional(),
     // ... other GitHub config
   });
   ```

3. **Root Configuration Schema**
   ```typescript
   // src/domain/configuration/schemas/index.ts
   export const configSchema = z.object({
     backend: z.enum(['markdown', 'json', 'sqlite']).default('markdown'),
     sessiondb: sessionDbSchema,
     github: githubSchema,
     ai: aiSchema,
     // ... other domains
   });

   export type Configuration = z.infer<typeof configSchema>;
   ```

#### **Task 2.2: Implement Configuration Loader**

1. **Configuration Sources**
   ```typescript
   // src/domain/configuration/sources/
   // - defaults.ts - default values
   // - project.ts - project-level overrides
   // - user.ts - user-level overrides
   // - environment.ts - environment variables
   ```

2. **Merge Strategy**
   ```typescript
   // src/domain/configuration/loader.ts
   export class ConfigurationLoader {
     async load(): Promise<Configuration> {
       const sources = await this.loadAllSources();
       const merged = this.mergeSources(sources);
       return configSchema.parse(merged);
     }
   }
   ```

3. **Environment Variable Mapping**
   ```typescript
   // Automatic mapping: MINSKY_GITHUB_TOKEN -> config.github.token
   // Support nested paths: MINSKY_AI_PROVIDERS_OPENAI_API_KEY -> config.ai.providers.openai.apiKey
   ```

#### **Task 2.3: Implement Configuration API**

1. **Main Configuration Export**
   ```typescript
   // src/domain/configuration/index.ts
   export const config: Configuration = await loadConfiguration();
   export { configSchema, type Configuration } from './schemas';
   ```

2. **Validation Utilities**
   ```typescript
   // src/domain/configuration/validation.ts
   export function validateConfiguration(config: unknown): Configuration;
   export function validatePartial<T>(schema: ZodSchema<T>, config: unknown): T;
   ```

3. **Testing Utilities**
   ```typescript
   // src/domain/configuration/testing.ts
   export function withTestConfig<T>(overrides: DeepPartial<Configuration>, fn: () => T): T;
   export async function withTestConfigAsync<T>(overrides: DeepPartial<Configuration>, fn: () => Promise<T>): Promise<T>;
   ```

### **Phase 3: Migration and Integration**

#### **Task 3.1: Replace Node-Config Usage**

1. **Update All Imports**
   - Replace `import config from "config"` with `import { config } from "../domain/configuration"`
   - Update all `config.get()` calls to direct property access
   - Add type annotations where needed

2. **Update Configuration Files**
   - Convert YAML files to TypeScript/JSON
   - Migrate environment variable mappings
   - Update project and user configuration files

#### **Task 3.2: Update Tests**

1. **Configuration Tests**
   - Test schema validation
   - Test configuration loading and merging
   - Test environment variable mapping
   - Test error handling

2. **Integration Tests**
   - Update existing tests to use new configuration API
   - Test configuration overrides in test environment
   - Verify no regressions

#### **Task 3.3: Remove Node-Config**

1. **Remove Dependencies**
   - Remove `config` and `@types/config` from package.json
   - Remove `config/` directory
   - Clean up any remaining node-config references

2. **Update Documentation**
   - Document new configuration system
   - Update setup instructions
   - Document schema definitions and validation

## Detailed Requirements from Task #181

Based on Task #181 analysis, our configuration system needs to support:

### **Configuration Domains Identified**

1. **Backend Configuration**
   ```typescript
   backend: z.enum(['markdown', 'json-file', 'sqlite']).default('markdown')
   ```

2. **SessionDB Configuration**
   ```typescript
   sessiondb: z.object({
     backend: z.enum(['json', 'sqlite', 'postgres']).default('json'),
     // ... database connection details
   })
   ```

3. **GitHub Configuration**
   ```typescript
   github: z.object({
     token: z.string().optional(),
     organization: z.string().optional(),
     // ... other GitHub settings
   })
   ```

4. **AI Provider Configuration**
   ```typescript
   ai: z.object({
     providers: z.object({
       openai: z.object({
         apiKey: z.string().optional(),
         model: z.string().default('gpt-4'),
       }),
       anthropic: z.object({
         apiKey: z.string().optional(),
         model: z.string().default('claude-3-sonnet'),
       }),
     }),
   })
   ```

### **Environment Variable Mapping**

Current environment variables that need mapping:
- `GITHUB_TOKEN` → `config.github.token`
- `OPENAI_API_KEY` → `config.ai.providers.openai.apiKey`
- `ANTHROPIC_API_KEY` → `config.ai.providers.anthropic.apiKey`
- `MINSKY_BACKEND` → `config.backend`
- `MINSKY_SESSIONDB_BACKEND` → `config.sessiondb.backend`

### **File Locations**

1. **Defaults**: `src/domain/configuration/defaults/` (TypeScript files)
2. **Project Overrides**: `config/` (committed to git)
3. **User Overrides**: `~/.config/minsky/config.yaml` or `~/.config/minsky/config.json`

## Success Criteria

1. **✅ Type Safety**: All configuration access is type-safe with auto-completion
2. **✅ Validation**: Runtime validation with clear error messages
3. **✅ Hierarchy**: Proper precedence for configuration sources
4. **✅ Migration**: All existing functionality preserved
5. **✅ Performance**: No significant performance impact
6. **✅ Testing**: Easy configuration overrides for testing
7. **✅ Documentation**: Clear documentation and examples

## Risk Mitigation

1. **Backward Compatibility**: Maintain existing environment variable names and behavior
2. **Incremental Migration**: Migrate one domain at a time
3. **Test Coverage**: Comprehensive test suite before removing node-config
4. **Rollback Plan**: Keep node-config until custom system is fully verified

## Implementation Progress

### Phase 1: Requirements Analysis ✅ COMPLETED
**Day 1: Configuration Domain Analysis**
- ✅ Analyzed existing `config.get()` usage patterns across codebase
- ✅ Reverse-engineered configuration requirements from Task #181
- ✅ Identified 7 main configuration domains: backend, sessiondb, github, ai, logger, plus base schemas
- ✅ Mapped environment variable usage patterns (`MINSKY_*`, specific vars)
- ✅ Designed hierarchical configuration precedence: Environment Variables (100) > User Config (50) > Project Config (25) > Defaults (0)

### Phase 2: Core Implementation
**Day 1: Schema Foundation ✅ COMPLETED**
- ✅ Created base Zod schemas for common types (`filePath`, `url`, `port`, etc.)
- ✅ Implemented schema utilities (`optional`, `withDefault`, `deepPartial`, `fromEnvVar`)
- ✅ Built enum schemas for configuration options
- ✅ Created credential and file configuration schemas

**Day 2: Domain-Specific Schemas ✅ COMPLETED**
- ✅ **Backend Schema**: Task backend types, detection rules, backend-specific configs
- ✅ **SessionDB Schema**: Multi-backend support (json, sqlite, postgres) with legacy compatibility
- ✅ **GitHub Schema**: Token management, repository configuration, validation utilities
- ✅ **AI Schema**: Multi-provider support (OpenAI, Anthropic, Google, Cohere, Mistral)
- ✅ **Logger Schema**: Logging modes, levels, file configuration
- ✅ **Root Schema**: Combined configuration with complete type inference

**Day 2: Configuration Sources ✅ COMPLETED**
- ✅ **Defaults Source**: Application defaults with environment-specific overrides
- ✅ **Environment Source**: Explicit mappings + automatic `MINSKY_*` variable conversion
- ✅ **Project Source**: Git-committed configuration files (`config/local.yaml`, `.minsky/config.json`)
- ✅ **User Source**: XDG-compliant user configuration (`~/.config/minsky/config.yaml`)

**Day 3: Configuration Loader ⏳ IN PROGRESS**
- ⏳ Main configuration loader with hierarchical merging
- ⏳ Source orchestration and conflict resolution
- ⏳ Error handling and validation result aggregation
- ⏳ Cache management and reload capabilities

**Day 4: Validation and Testing 📋 PENDING**
- 📋 Comprehensive validation with detailed error reporting
- 📋 Test suite for all configuration scenarios
- 📋 Edge case handling (missing files, invalid formats, partial configs)
- 📋 Performance optimization and benchmarking

**Day 5: Public API 📋 PENDING**
- 📋 Clean configuration API with direct property access
- 📋 Type-safe getters with IntelliSense support
- 📋 Configuration utilities (reload, validate, inspect)
- 📋 Developer tools and debugging helpers

### Phase 3: Migration and Integration 📋 PENDING
**Day 6: Replace Node-Config Usage**
- 📋 Replace all `config.get()` calls with new API
- 📋 Update imports across codebase
- 📋 Remove node-config dependency and setup files
- 📋 Update configuration files to new format

**Day 7: Testing and Cleanup**
- 📋 Full integration testing
- 📋 Performance benchmarking
- 📋 Documentation updates
- 📋 Final cleanup and optimization

## Files Created ✅

### **Schema Files** ✅ COMPLETED
- ✅ `src/domain/configuration/schemas/index.ts` - Root configuration schema
- ✅ `src/domain/configuration/schemas/base.ts` - Common base schemas and utilities
- ✅ `src/domain/configuration/schemas/backend.ts` - Task backend configuration
- ✅ `src/domain/configuration/schemas/sessiondb.ts` - Session database configuration
- ✅ `src/domain/configuration/schemas/github.ts` - GitHub integration configuration
- ✅ `src/domain/configuration/schemas/ai.ts` - AI provider configuration
- ✅ `src/domain/configuration/schemas/logger.ts` - Logger configuration

### **Source Loaders** ✅ COMPLETED
- ✅ `src/domain/configuration/sources/defaults.ts` - Application defaults
- ✅ `src/domain/configuration/sources/environment.ts` - Environment variable handling
- ✅ `src/domain/configuration/sources/project.ts` - Project-level configuration files
- ✅ `src/domain/configuration/sources/user.ts` - User-level XDG configuration

### **Core Implementation** ⏳ IN PROGRESS
- ⏳ `src/domain/configuration/loader.ts` - Main configuration loader
- 📋 `src/domain/configuration/validation.ts` - Validation utilities
- 📋 `src/domain/configuration/testing.ts` - Testing helpers
- 📋 `src/domain/configuration/index.ts` - Public API

## Timeline

**Estimated Timeline: 7 days total**
- Phase 2.1: 2 days (Schema + Sources) ✅ COMPLETED
- Phase 2.2: 2 days (Loading + Validation) ⏳ Day 3 IN PROGRESS
- Phase 2.3: 1 day (API + Integration)
- Phase 3: 2 days (Migration + Testing)

**Current Status**: Day 3 of 7 - Beginning configuration loader implementation

### **Default Configuration**
- `src/domain/configuration/defaults/backend.ts`
- `src/domain/configuration/defaults/sessiondb.ts`
- `src/domain/configuration/defaults/github.ts`
- `src/domain/configuration/defaults/ai.ts`

## Files to Remove (After Migration)

- `config/default.yaml`
- `config/custom-environment-variables.yaml`
- Node-config related imports and usage throughout codebase

---

*This task will create a modern, type-safe configuration system tailored specifically to our needs, providing better developer experience and maintainability than existing libraries.*
