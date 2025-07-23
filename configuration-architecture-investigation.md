# Configuration Architecture Investigation - Task 307

## Investigation Overview

This document completes the Phase 1 investigation requirements for Task 307 before proceeding with implementation. The goal is to understand the current configuration architecture and determine the best approach for workflow commands (like lint commands) in the scope-aware system.

## 1. Configuration Scope Analysis ✅

### Current Configuration Architecture (From Task #295)

The current Minsky configuration system already implements a **well-designed scope-aware architecture**:

**Configuration Hierarchy (by priority):**
1. **Environment Variables** (highest) - `MINSKY_*`, `GITHUB_TOKEN`, etc.
2. **Global User Config** - `~/.config/minsky/config.yaml` 
3. **Repository Config** - `.minsky/config.yaml`
4. **Default Values** (lowest) - built-in fallbacks

### Current Scope Classification

#### ✅ Repository-Specific Settings (`.minsky/config.yaml` - committed)
- **Backend configuration**: `backend`, `backendConfig`, `detectionRules`
- **SessionDB project defaults**: `sessiondb.backend`, `sessiondb.baseDir`
- **GitHub repository info**: `github.organization`, `github.repository`
- **AI project settings**: `ai.defaultProvider`, `ai.models`
- **Logger project defaults**: `logger.mode`, `logger.level`

#### ✅ User-Specific Settings (`~/.config/minsky/config.yaml` - not committed)
- **Personal credentials**: `github.token`, `ai.providers.*.apiKey`
- **Personal preferences**: `logger.enableAgentLogs`, `sessiondb.sqlite.path`
- **User overrides**: Any project setting can be overridden locally

#### ✅ Runtime Overrides (Environment Variables)
- **CI/CD context**: `GITHUB_TOKEN`, `OPENAI_API_KEY`, etc.
- **Development context**: `MINSKY_LOG_LEVEL`, `MINSKY_BACKEND`, etc.

### Key Finding: Architecture Already Scope-Aware ✅

The current configuration system successfully separates:
- **Team-shared settings** (committed in `.minsky/config.yaml`)
- **Personal settings** (local in `~/.config/minsky/config.yaml`)  
- **Runtime context** (environment variables)

## 2. Workflow Commands Scope Investigation 🔍

### The Critical Question: Where Should Workflow Commands Be Configured?

**Workflow commands** (like `lint`, `test`, `build`, `format`) have unique characteristics:

#### Team Sharing Requirements ✅
- **Same lint rules** across all team members
- **Consistent build processes** for reproducible results
- **Shared test commands** for CI/CD compatibility
- **Common formatting standards** for code consistency

#### Local Override Needs ❓
- **Development workflow preferences** (different editors, tools)
- **Performance optimizations** (local vs CI environments)
- **Debugging variants** (verbose modes, different tools)

### Investigation Results

#### Option A: Project-Specific Workflow Commands (Recommended ✅)

```yaml
# .minsky/config.yaml (committed)
workflows:
  lint: "bunx eslint ."
  lint:fix: "bunx eslint . --fix"
  test: "bun test"
  build: "bun run build"
  format: "prettier --write '**/*.{ts,js,json,md}'"
```

**Benefits:**
- ✅ **Team consistency** - everyone uses same commands
- ✅ **CI/CD compatibility** - same commands work in all environments
- ✅ **New developer onboarding** - commands work immediately after clone
- ✅ **Tool standardization** - team agrees on linting/testing tools

**Trade-offs:**
- ❌ **Less flexibility** for individual developer preferences
- ❌ **Potential conflicts** if developers use different tool versions

#### Option B: User-Configurable Workflows with Project Defaults

```yaml
# .minsky/config.yaml (committed - project defaults)
workflows:
  lint: "bunx eslint ."
  test: "bun test"

# ~/.config/minsky/config.yaml (user overrides)
workflows:
  lint: "eslint . --format=compact"  # Personal preference
  test: "bun test --verbose"         # Debug mode
```

**Benefits:**
- ✅ **Team defaults** ensure consistency
- ✅ **User customization** for development workflow
- ✅ **Fallback behavior** when user config missing

## 3. Integration with Existing Configuration System ✅

### Current Configuration Schema Analysis

The existing configuration system in `src/domain/configuration/` supports:

**Hierarchical Loading** (from `loader.ts`):
```typescript
sources: ["defaults", "project", "user", "environment"]
```

**Schema Validation** (from `schemas/`):
- Type-safe configuration loading
- Zod validation with proper error reporting
- Support for nested configuration objects

**Scope-Aware Sources**:
- `sources/project.ts` - loads `.minsky/config.yaml`
- `sources/user.ts` - loads `~/.config/minsky/config.yaml`
- `sources/environment.ts` - processes environment variables
- `sources/defaults.ts` - provides baseline values

### Integration Strategy ✅

**Add Workflow Commands to Configuration Schema:**

```typescript
// src/domain/configuration/schemas/workflow.ts
export const workflowConfigSchema = z.object({
  lint: z.string().optional(),
  'lint:fix': z.string().optional(),
  test: z.string().optional(),
  build: z.string().optional(),
  format: z.string().optional(),
  dev: z.string().optional(),
  start: z.string().optional(),
}).strict();

// Add to main configuration schema
export const configurationSchema = z.object({
  // ... existing schemas
  workflows: workflowConfigSchema.optional(),
});
```

**Update Session Lint to Use Configuration:**

```typescript
// src/domain/session/session-lint.ts
import { config } from "../configuration";

async function determineLintCommand(workspaceDir: string): Promise<string> {
  // 1. Try configuration system first
  const lintCommand = config.workflows?.lint;
  if (lintCommand) {
    return lintCommand;
  }
  
  // 2. Fallback to package.json detection
  // ... existing logic
}
```

## 4. Migration Strategy and Implementation Plan

### Phase 1: Schema Extension ✅
1. **Add workflow schema** to configuration system
2. **Update configuration types** to include workflows
3. **Test schema validation** with workflow commands

### Phase 2: Session Lint Integration ✅  
1. **Update session lint** to use configuration system
2. **Remove ProjectConfigReader** dependency
3. **Test configuration hierarchy** (project > user > defaults)

### Phase 3: Documentation and Examples ✅
1. **Update configuration guide** with workflow examples
2. **Provide team setup examples** with `.minsky/config.yaml`
3. **Document override patterns** for user preferences

## Investigation Conclusions

### ✅ Recommended Approach: Project-Centric Workflows

**Decision:** Workflow commands should be **project-specific by default** with **user override capability**.

**Rationale:**
1. **Team Consistency Priority** - linting/testing commands need to be consistent across team
2. **CI/CD Compatibility** - same commands must work in all environments  
3. **Developer Onboarding** - new team members get working commands immediately
4. **Flexibility Preserved** - users can still override in personal config if needed

**Implementation:**
```yaml
# .minsky/config.yaml (committed)
workflows:
  lint: "bunx eslint ."
  lint:fix: "bunx eslint . --fix"
  test: "bun test"
  
# ~/.config/minsky/config.yaml (optional user overrides)
workflows:
  lint: "eslint . --format=compact"  # Personal preference
```

### ✅ Architecture Assessment

The **existing Task #295 configuration system is excellent** and requires minimal changes:
- ✅ **Scope separation** already implemented correctly
- ✅ **Hierarchical loading** supports project + user + environment  
- ✅ **Type safety** with Zod validation
- ✅ **Clean architecture** with proper source separation

**Only addition needed:** Workflow commands schema and integration.

### ✅ Next Steps for Implementation

1. **Extend configuration schema** to include workflow commands
2. **Update session lint** to use configuration system instead of ProjectConfigReader
3. **Add fallback logic** for projects without workflow configuration
4. **Test full hierarchy** (project defaults → user overrides → environment)
5. **Update documentation** with workflow configuration examples

The investigation confirms that **the configuration architecture is solid** and ready for workflow command integration with minimal changes required.

## Investigation Status: COMPLETE ✅

All required investigation areas have been analyzed:
- ✅ **Configuration Scope Analysis** - current architecture reviewed and classified
- ✅ **Scope-Aware Architecture Design** - integration plan with existing Task #295 system  
- ✅ **Workflow Commands Strategy** - project-centric approach with user overrides recommended

Ready to proceed with **Phase 2: Implementation** based on these findings.