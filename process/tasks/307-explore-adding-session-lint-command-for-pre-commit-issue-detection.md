# Explore adding session lint command for pre-commit issue detection

## Status

IN-PROGRESS  

## Priority

MEDIUM

## Description

Research and design a `session lint` command that can detect various issues in a session workspace before attempting to commit changes. This would help catch problems early in the development workflow.

## ✅ Completed Work (Session Implementation)

### Core Implementation Complete

- ✅ **Working `session lint` command** - fully functional with ESLint integration
- ✅ **Auto-registration** - available in both CLI and MCP interfaces via SharedCommandRegistry
- ✅ **Command parameters** - supports `--fix`, `--quiet`, `--changed`, `--json` flags  
- ✅ **Enhanced output** - shows executed command, error/warning counts, execution time
- ✅ **Error handling** - graceful handling of ESLint failures and workspace issues
- ✅ **Session workspace integration** - works within session directory context

### Command Interface

```bash
# Full functionality available
minsky session lint --help
minsky session lint --session-name task307
minsky session lint --fix --quiet
minsky session lint --json
```

### Testing Results

- ✅ Successfully executes ESLint in session workspaces
- ✅ Auto-detects and uses project lint configuration
- ✅ Supports auto-fix functionality with `--fix` flag
- ✅ Provides enhanced output with performance metrics
- ✅ Handles exit codes properly (0=success, >0=issues found)

## 🔧 Remaining Work (Configuration Integration)

### Critical Issue: Redundant Configuration System

The current implementation uses a **redundant configuration approach** that needs to be fixed:

#### Current Problematic Approach:
- ❌ **Separate `minsky.json` file** (should use existing `.minsky/config.yaml`)
- ❌ **Custom `ProjectConfigReader` class** (should use existing `ConfigurationService`)  
- ❌ **Duplicate configuration types** (should use existing configuration schema)
- ❌ **New configuration hierarchy** (ignores existing 5-level Minsky config system)

#### Required Fix:
The session lint command should integrate with **existing Minsky configuration system**:

```yaml
# Existing .minsky/config.yaml format (Task #295)
version: 1
backends:
  default: "github-issues"
# Add workflow section:
workflows:
  lint: "bun run lint"  
  test: "bun test"
  build: "bun run build"
  dev: "bun run start"
```

### 🔍 Critical Investigation Required: Configuration Scope Architecture

#### Current Architecture Problem

The current Minsky configuration system doesn't clearly differentiate between:

**Project-Specific Configuration** (should be committed to git):
- ✅ **Workflow commands** (`lint`, `test`, `build`, `dev`) - **THIS IS WHAT WE NEED**
- ✅ **Project backend overrides** (team-shared backend choices)
- ✅ **Repository-specific settings** (GitHub owner/repo for issues backend)
- ✅ **Project task management settings**

**System-Level User Defaults** (personal, not committed):
- ❌ **Credentials/tokens** (GitHub tokens, API keys)
- ❌ **Personal backend preferences** (user's default sessiondb choice)
- ❌ **User interface preferences** (output formats, verbosity)
- ❌ **Local development settings**

#### Investigation Questions

1. **Configuration Scope Classification**
   - Which existing `.minsky/config.yaml` settings should be project-specific vs user-specific?
   - How should workflow commands (`lint`, `test`, `build`) be scoped?
   - Should we separate project config from user config more clearly?

2. **Architecture Options**
   
   **Option A: Current Approach** (single `.minsky/config.yaml`)
   ```yaml
   # .minsky/config.yaml (committed)
   version: 1
   backends:
     default: "github-issues"  # Project-specific
   workflows:
     lint: "bun run lint"      # Project-specific
   ```
   
   **Option B: Scope Separation**
   ```yaml
   # .minsky/config.yaml (committed, project-specific)
   version: 1
   project:
     workflows:
       lint: "bun run lint"
       test: "bun test"
     backends:
       default: "github-issues"
   
   # ~/.config/minsky/config.yaml (user-specific)
   version: 1
   user:
     credentials:
       github_token: "..."
     preferences:
       default_sessiondb: "sqlite"
   ```
   
   **Option C: File Separation**
   ```
   .minsky/
     project.yaml     # Project workflows, backends (committed)
     local.yaml       # Local overrides (gitignored)
   ~/.config/minsky/
     user.yaml        # User credentials, preferences
   ```

3. **Workflow Commands Scope Analysis**
   - Are `lint`/`test`/`build` commands project-specific? ✅ **YES** - teams need consistency
   - Should they be committed to git? ✅ **YES** - shared across team
   - Do they need user overrides? ❓ **INVESTIGATE** - maybe for local development
   - How do they interact with existing backend config? ❓ **UNCLEAR**

4. **Integration with Task #295 Configuration System**
   - Does the existing `ConfigurationService` support scope separation?
   - How would this affect the 5-level hierarchy (CLI > env > user > repo > defaults)?
   - What changes are needed to support project vs user config clearly?

#### Investigation Tasks

1. **Analyze Current Configuration Usage**
   - Audit all `.minsky/config.yaml` settings across Minsky codebase
   - Classify each setting as project-specific vs user-specific
   - Identify settings that need both scopes (with override behavior)

2. **Review Task #295 Configuration Architecture**
   - Examine `ConfigurationService` implementation for scope support
   - Determine if current hierarchy can handle scope separation
   - Identify required changes for scope-aware configuration

3. **Design Scope-Aware Configuration**
   - Propose clear separation between project and user configuration
   - Design file structure and hierarchy for scope separation
   - Plan migration strategy from current mixed approach

4. **Workflow Commands Integration Strategy**
   - Determine best approach for project-specific workflow commands
   - Plan team sharing vs local override capabilities
   - Design fallback behavior when project config missing

### Remaining Configuration Tasks

1. **🔍 INVESTIGATE: Configuration Scope Architecture** (NEW)
   - Complete scope analysis and architecture design
   - Determine project-specific vs user-specific configuration separation
   - Design integration with existing `ConfigurationService`

2. **Replace ProjectConfigReader** 
   - Remove `src/domain/project/` module entirely
   - Use existing `ConfigurationService` from `src/domain/configuration/`
   - Implement scope-aware configuration loading (based on investigation results)

3. **Update Session Lint Implementation**
   - Modify `src/domain/session/session-lint.ts` to use scope-aware configuration
   - Remove dependency on `ProjectConfigReader`
   - Read lint command from appropriate config scope (project vs user)

4. **Remove Redundant Files**
   - Delete `minsky.json` sample file
   - Delete `src/domain/project/` directory
   - Update imports in session lint command

5. **Integration Testing**
   - Test with scope-separated configuration files
   - Verify hierarchy works (user config overrides, project config, etc.)
   - Test fallback behavior when project config missing

6. **Update Documentation**
   - Document scope-aware configuration architecture
   - Update examples to use proper configuration separation
   - Document team sharing vs user override behavior

## Scope of Research

### ✅ Completed Research Areas

#### 1. Command Interface ✅
- **Syntax**: `minsky session lint [options]` - implemented and working
- **Parameters**: `--fix`, `--quiet`, `--changed`, `--json` - all functional
- **Output**: Human-readable with JSON option, color-coded, performance metrics
- **Exit codes**: Proper codes for success/warnings/errors

#### 2. Integration Points ✅  
- **Session workflow**: Integrated with existing session workspace context
- **Auto-registration**: Uses SharedCommandRegistry for CLI/MCP availability
- **ESLint integration**: Respects existing project ESLint configuration
- **Performance**: Completes in ~6 seconds for typical session

#### 3. User Experience ✅
- **Help documentation**: Full help available via `--help`
- **Output formatting**: Summary and detailed output options
- **Interactive feedback**: Clear success/error reporting
- **Tool integration**: JSON output for programmatic usage

### 🔧 Research Areas Needing Completion

#### 1. Configuration Architecture
- **Current state**: Redundant configuration system implemented
- **Required**: Integration with existing Minsky configuration system
- **Priority**: High - architectural consistency critical

#### 2. Extended Linting Capabilities  
- **Current state**: ESLint-only implementation
- **Future scope**: TypeScript compiler, import validation, git status, test syntax
- **Priority**: Medium - basic ESLint covers most use cases

#### 3. Performance Optimization
- **Current state**: Runs full ESLint on entire workspace
- **Future scope**: Incremental linting, caching, parallel execution
- **Priority**: Low - current performance acceptable

## Requirements

### ✅ Completed Functional Requirements

1. **Command Interface** ✅
   - ✅ `minsky session lint` command implemented in CLI adapter
   - ✅ Support for `--fix`, `--json`, `--quiet`, `--changed` flags
   - ✅ Clear exit codes (0=success, >0=issues)
   - ✅ Help documentation and examples

2. **Core Linting Capabilities** ✅
   - ✅ ESLint integration (respects existing .eslintrc config)
   - ✅ Works within session workspace context
   - ✅ Handles TypeScript and JavaScript projects
   - ✅ Auto-fix functionality

3. **Output Requirements** ✅
   - ✅ Human-readable summary with error/warning counts
   - ✅ JSON output option for tool integration
   - ✅ Performance metrics (execution time, command used)
   - ✅ Clear success/failure reporting

### 🔧 Remaining Technical Requirements

1. **Configuration Integration** ❌
   - Replace redundant configuration system
   - Use existing Minsky configuration hierarchy
   - Support workflow commands in `.minsky/config.yaml`

2. **Extended Linting** (Future)
   - TypeScript compilation check
   - Import/export validation  
   - Git status validation
   - Test syntax validation

3. **Performance Optimization** (Future)
   - Incremental checking (only changed files)
   - Parallel execution where possible
   - Caching strategies

## Success Criteria

### ✅ Current Implementation Success

- ✅ Working session lint command with ESLint integration
- ✅ Auto-registration in CLI and MCP interfaces
- ✅ Proper parameter handling and output formatting
- ✅ Integration with session workspace workflow
- ✅ Foundation for task #321 AI-powered project analysis

### 🔧 Configuration Integration Success

- [ ] **🔍 Complete Configuration Scope Investigation** (NEW PRIORITY)
  - Analyze existing configuration usage and classify by scope
  - Design scope-aware architecture (project vs user vs local)
  - Plan integration with Task #295 `ConfigurationService`
  - Define migration strategy for scope separation

- [ ] Remove redundant `ProjectConfigReader` and `minsky.json` approach
- [ ] Integrate with existing `ConfigurationService` from task #295
- [ ] Support workflow commands in proper configuration scope (based on investigation)
- [ ] Test configuration hierarchy (user overrides, repo config, defaults)
- [ ] Update documentation to reflect scope-aware configuration usage

### 📋 Future Enhancement Success (Optional)

- [ ] Extended linting capabilities (TypeScript, imports, git status)
- [ ] Performance optimization (incremental, caching, parallel)
- [ ] Plugin architecture for custom checks
- [ ] Integration with pre-commit hooks

## Acceptance Criteria

### Phase 1: Configuration Architecture Investigation (NEW)

This investigation phase is complete when:

1. **Configuration Scope Analysis** ✅
   - Complete audit of existing `.minsky/config.yaml` usage across codebase
   - Clear classification of settings: project-specific vs user-specific vs local-override
   - Analysis of workflow commands scope requirements (team sharing, local overrides)
   - Documentation of current architecture problems and limitations

2. **Scope-Aware Architecture Design** ✅
   - Detailed design for project vs user configuration separation
   - Integration plan with existing Task #295 `ConfigurationService`
   - File structure and hierarchy design for scope separation
   - Migration strategy from current mixed approach to scope-aware approach

3. **Workflow Commands Strategy** ✅
   - Clear decision on workflow commands scope (project-specific with local overrides)
   - Design for team sharing capabilities (committed to git)
   - Fallback behavior when project configuration missing
   - Integration approach with existing configuration hierarchy

### Phase 2: Implementation (After Investigation)

This implementation phase is complete when:

1. **Configuration Integration** ✅
   - Session lint command uses scope-aware configuration system
   - Workflows defined in appropriate configuration scope
   - All redundant configuration code removed (`src/domain/project/`, `minsky.json`)
   - Full testing with scope-separated configuration hierarchy

2. **Documentation Update** ✅
   - Scope-aware configuration usage documented in Minsky config docs
   - Examples updated to use proper configuration separation approach
   - Team sharing vs local override behavior documented
   - Integration with task #321 project analysis documented

### Future Phases (Optional)

3. **Extended Capabilities** (Future phase)
   - Additional linting types beyond ESLint
   - Performance optimizations
   - Plugin architecture

## Notes

- **Foundation established**: Core session lint functionality working
- **Critical investigation needed**: Configuration scope architecture must be designed first
- **Architecture impact**: This investigation affects broader Minsky configuration patterns
- **Task #321 dependency**: Provides foundation for AI-powered project analysis
- **Performance**: Current implementation acceptable for typical usage
- **Team vs Personal**: Workflow commands clearly need project-specific scope with team sharing
