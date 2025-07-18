# Task #295 Implementation Plan - Custom Type-Safe Configuration System

## Executive Summary

After comprehensive analysis of the current node-config system and Task #181 history, I've identified that while the previous migration was technically successful, node-config fundamentally doesn't align with our architectural needs. This task will implement a custom configuration system that provides:

1. **True Type Safety**: Zod schemas with TypeScript integration
2. **Flexible Hierarchy**: Custom precedence without node-config's rigid conventions  
3. **Simple API**: Direct property access (`config.github.token`)
4. **Domain Organization**: Composable configuration sections

## Phase 1.1: Requirements Analysis (COMPLETED)

### Configuration Domains Identified

#### **1. Backend Configuration** 
```typescript
backend: z.enum(['markdown', 'json-file', 'github-issues']).default('markdown')
```

#### **2. SessionDB Configuration**
```typescript
sessiondb: z.object({
  backend: z.enum(['json', 'sqlite', 'postgres']).default('sqlite'),
  baseDir: z.string().optional(),
  dbPath: z.string().optional(), 
  connectionString: z.string().optional(),
})
```

#### **3. GitHub Configuration**
```typescript
github: z.object({
  token: z.string().optional(),
  organization: z.string().optional(),
})
```

#### **4. AI Provider Configuration**
```typescript
ai: z.object({
  providers: z.object({
    openai: z.object({
      apiKey: z.string().optional(),
      model: z.string().default('gpt-4'),
      enabled: z.boolean().default(true),
      models: z.array(z.string()).default([]),
    }),
    anthropic: z.object({
      apiKey: z.string().optional(),
      model: z.string().default('claude-3-sonnet'),
      enabled: z.boolean().default(true),
      models: z.array(z.string()).default([]),
    }),
    // ... other providers
  }),
})
```

#### **5. Logger Configuration**
```typescript
logger: z.object({
  mode: z.enum(['HUMAN', 'STRUCTURED', 'auto']).default('auto'),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  enableAgentLogs: z.boolean().default(false),
})
```

#### **6. Backend Detection**
```typescript
detectionRules: z.array(z.object({
  condition: z.enum(['tasks_md_exists', 'json_file_exists', 'always']),
  backend: z.string(),
}))
```

### Environment Variable Mapping Required

Current environment variables that need automatic mapping:

- `GITHUB_TOKEN` → `config.github.token`
- `GH_TOKEN` → `config.github.token` (fallback)
- `OPENAI_API_KEY` → `config.ai.providers.openai.apiKey`
- `ANTHROPIC_API_KEY` → `config.ai.providers.anthropic.apiKey`
- `MINSKY_LOG_MODE` → `config.logger.mode`
- `LOGLEVEL` → `config.logger.level`
- `ENABLE_AGENT_LOGS` → `config.logger.enableAgentLogs`
- `MINSKY_BACKEND` → `config.backend`
- `MINSKY_SESSIONDB_BACKEND` → `config.sessiondb.backend`

### Configuration Hierarchy Design

**Precedence (highest to lowest):**
1. **Environment Variables** - Runtime overrides
2. **User Config** (`~/.config/minsky/config.yaml`) - Personal preferences
3. **Project Config** (`config/local.yaml`) - Project-specific overrides  
4. **Defaults** - TypeScript-defined defaults

### Current Usage Patterns Analysis

From codebase analysis, configuration is accessed via:
- `config.get("backend")` → Should become `config.backend`
- `config.get("sessiondb")` → Should become `config.sessiondb` 
- `config.get("github")` → Should become `config.github`
- `config.get("ai")` → Should become `config.ai`
- `config.get("detectionRules")` → Should become `config.detectionRules`

## Phase 1.2: Architecture Design (COMPLETED)

### Core Architecture Principles

1. **Single Source of Truth**: One configuration object accessible throughout app
2. **Lazy Loading**: Configuration loaded once on first access
3. **Immutable**: Configuration object cannot be modified after loading
4. **Type Safe**: Full TypeScript support with auto-completion
5. **Testable**: Easy configuration overrides for testing

### Schema Organization Strategy

```
src/domain/configuration/
├── schemas/
│   ├── index.ts           # Root schema export
│   ├── base.ts           # Common schemas (url, filePath, etc.)
│   ├── backend.ts        # Backend configuration schema
│   ├── sessiondb.ts      # SessionDB configuration schema  
│   ├── github.ts         # GitHub configuration schema
│   ├── ai.ts            # AI provider configuration schema
│   ├── logger.ts        # Logger configuration schema
│   └── detection.ts     # Backend detection schema
├── sources/
│   ├── defaults.ts       # Default configuration values
│   ├── project.ts        # Project-level config loader
│   ├── user.ts          # User-level config loader  
│   └── environment.ts   # Environment variable mapper
├── loader.ts            # Main configuration loader
├── validation.ts        # Validation utilities
├── testing.ts          # Test configuration utilities
└── index.ts            # Public API exports
```

### Loading Strategy Design

```typescript
class ConfigurationLoader {
  private static instance: Configuration | null = null;

  static async load(): Promise<Configuration> {
    if (this.instance) return this.instance;
    
    const sources = await Promise.all([
      this.loadDefaults(),
      this.loadProjectConfig(), 
      this.loadUserConfig(),
      this.loadEnvironmentOverrides(),
    ]);
    
    const merged = this.mergeSources(sources);
    this.instance = configSchema.parse(merged);
    return this.instance;
  }
}
```

### Environment Variable Mapping Strategy

Automatic mapping using prefix pattern:
- `MINSKY_*` → Direct mapping (`MINSKY_BACKEND` → `config.backend`)  
- Known variables → Direct mapping (`GITHUB_TOKEN` → `config.github.token`)
- Nested paths → Dot notation (`AI_OPENAI_API_KEY` → `config.ai.providers.openai.apiKey`)

### Testing Strategy Design

```typescript
// Test utilities for configuration overrides
export function withTestConfig<T>(
  overrides: DeepPartial<Configuration>, 
  fn: () => T
): T {
  const original = ConfigurationLoader.instance;
  const testConfig = mergeConfig(original, overrides);
  ConfigurationLoader.instance = testConfig;
  
  try {
    return fn();
  } finally {
    ConfigurationLoader.instance = original;
  }
}
```

## Phase 2: Implementation Plan

### Phase 2.1: Core Infrastructure (2 days)

#### **Day 1: Schema Foundation** ✅ COMPLETED
- [x] Create base schema types (`src/domain/configuration/schemas/base.ts`)
- [x] Implement domain-specific schemas (backend, sessiondb, github, ai, logger)
- [x] Create root configuration schema with proper composition
- [x] Add TypeScript type inference from schemas

#### **Day 2: Configuration Sources**
- [ ] Implement default configuration values
- [ ] Create project config file loader (YAML/JSON support)
- [ ] Create user config file loader with XDG compliance
- [ ] Implement environment variable mapping system

### Phase 2.2: Loading and Validation (2 days)

#### **Day 3: Configuration Loader**
- [ ] Implement ConfigurationLoader with merge strategy
- [ ] Add configuration caching and singleton pattern
- [ ] Create hierarchical merge logic with proper precedence
- [ ] Add error handling for invalid configurations

#### **Day 4: Validation and Testing**
- [ ] Implement validation utilities with detailed error messages
- [ ] Create test configuration override system
- [ ] Add configuration debugging and inspection tools
- [ ] Create development utilities for config validation

### Phase 2.3: API and Integration (1 day)

#### **Day 5: Public API**
- [ ] Create main configuration export (`config` object)
- [ ] Implement lazy loading with proper error handling
- [ ] Add TypeScript declarations for IDE support
- [ ] Create configuration inspection utilities

## Phase 3: Migration and Integration (2 days)

### Phase 3.1: Replace Node-Config Usage (1 day)

#### **Day 6: Update All Imports**
- [ ] Replace `import config from "config"` with custom config import
- [ ] Update all `config.get()` calls to direct property access
- [ ] Migrate configuration validation logic
- [ ] Update credential resolution to use new system

### Phase 3.2: Testing and Cleanup (1 day) 

#### **Day 7: Final Integration**
- [ ] Update all test files to use new configuration system
- [ ] Remove node-config dependencies and config files
- [ ] Update CLI commands (config show, config list)
- [ ] Verify all tests pass with new system

## Success Metrics

### **Functional Requirements Met**
- [ ] All existing configuration values accessible via new system
- [ ] Environment variable mapping preserved and enhanced
- [ ] Configuration validation provides better error messages
- [ ] User and project configuration files work correctly

### **Developer Experience Improved**  
- [ ] Full TypeScript auto-completion for all config access
- [ ] Compile-time type checking for configuration usage
- [ ] Clear error messages for validation failures
- [ ] Easy testing with configuration overrides

### **Code Quality Enhanced**
- [ ] No more manual type assertions (`config.get("x") as Type`)
- [ ] Simplified configuration access (`config.github.token`)
- [ ] Reduced complexity from removing node-config setup
- [ ] Better organized configuration code

### **Performance Maintained**
- [ ] Configuration loading time ≤ current node-config performance
- [ ] Memory usage similar or better than current system
- [ ] No impact on application startup time

## Risk Mitigation

### **Rollback Strategy**
- All changes in session branch - can revert easily
- Node-config preserved until custom system fully verified
- Migration done incrementally with test validation at each step

### **Validation Strategy**
- Comprehensive test suite covering all configuration scenarios
- Manual testing of all CLI commands using configuration
- Validation of environment variable mapping edge cases
- Testing configuration precedence and override behavior

### **Quality Assurance**
- Code review of all schema definitions
- Performance testing of configuration loading
- Integration testing with all configuration consumers
- Documentation review and validation

## Files to Create (14 files)

### **Schema Files (7 files)**
- `src/domain/configuration/schemas/index.ts`
- `src/domain/configuration/schemas/base.ts`
- `src/domain/configuration/schemas/backend.ts`
- `src/domain/configuration/schemas/sessiondb.ts`
- `src/domain/configuration/schemas/github.ts`
- `src/domain/configuration/schemas/ai.ts`
- `src/domain/configuration/schemas/logger.ts`

### **Source Loaders (4 files)**
- `src/domain/configuration/sources/defaults.ts`
- `src/domain/configuration/sources/project.ts`
- `src/domain/configuration/sources/user.ts`
- `src/domain/configuration/sources/environment.ts`

### **Core Implementation (3 files)**
- `src/domain/configuration/loader.ts`
- `src/domain/configuration/validation.ts`
- `src/domain/configuration/testing.ts`

## Files to Update (15+ files)

### **Core Configuration**
- `src/domain/configuration/index.ts` - New exports
- `src/domain/configuration/types.ts` - Updated types

### **Configuration Consumers** 
- `src/domain/storage/monitoring/health-monitor.ts`
- `src/domain/configuration/backend-detection.ts`
- `src/domain/configuration/credential-resolver.ts`
- `src/domain/tasks/taskService.ts`
- `src/adapters/shared/commands/config.ts`
- `src/commands/config/show.ts`
- `src/commands/config/list.ts`
- All test files using configuration

### **Remove Node-Config Setup**
- `src/config-setup.ts` - Delete entire file
- `src/cli.ts` - Remove config-setup import
- `config/default.yaml` - Delete after migration
- `config/test.yaml` - Delete after migration
- `package.json` - Remove config dependency

## Next Steps

Ready to begin Phase 2.1 implementation. Will start with creating the schema foundation and work incrementally through each phase, ensuring tests pass at every step.

**Estimated Timeline: 7 days total**
- Phase 2.1: 2 days (Schema + Sources)
- Phase 2.2: 2 days (Loading + Validation) 
- Phase 2.3: 1 day (API + Integration)
- Phase 3: 2 days (Migration + Testing)

**Ready to proceed with implementation.** 
