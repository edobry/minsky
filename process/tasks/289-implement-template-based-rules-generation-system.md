# Implement Template-Based Rules Generation System

## Status

🔄 **IN PROGRESS** - Task #289 core template system is implemented but CLI integration and testing issues remain.

## Priority

MEDIUM

## Description

# Task #289: Implement Template-Based Rules Generation System

## Context

Previously, Minsky rules were static `.mdc` files with hardcoded CLI command references. The `init` command generated rules using static content functions in `src/domain/init.ts`, with no way to conditionally reference CLI commands vs MCP tool calls based on project configuration.

This task implements a comprehensive templating system that enables:

1. ✅ Dynamic rule generation based on project configuration
2. ✅ Conditional referencing of CLI commands or MCP tool calls
3. ✅ Template variables and dynamic content generation
4. ✅ Maintained `.mdc` format compatibility

## 🏗️ **IMPLEMENTATION STATUS**

### **✅ COMPLETED: Core Infrastructure**

#### **1. RuleTemplateService**
- **Location**: `src/domain/rules/rule-template-service.ts`
- **Status**: ✅ **IMPLEMENTED**
- **Features**: 
  - Template management and rule generation orchestration
  - Configuration-driven rule generation
  - Template validation and metadata handling
  - Comprehensive error handling

#### **2. Template System**
- **Location**: `src/domain/rules/template-system.ts`
- **Status**: ✅ **IMPLEMENTED**
- **Features**:
  - Dynamic content generation with helper functions
  - Conditional interface support (CLI/MCP/Hybrid)
  - Template context management
  - Interface-specific command generation

#### **3. Command Generator**
- **Location**: `src/domain/rules/command-generator.ts`
- **Status**: ✅ **IMPLEMENTED**
- **Features**:
  - CLI to MCP command mapping
  - Dynamic syntax generation
  - Parameter documentation
  - Configuration-driven command references

#### **4. Default Templates**
- **Status**: ✅ **IMPLEMENTED** (8 comprehensive templates)
- **Location**: `src/domain/rules/default-templates.ts`

#### **5. Unit Tests**
- **Template System Tests**: ✅ **PASSING** (15+ tests)
- **Command Generator Tests**: ✅ **PASSING** (8+ tests)
- **Basic Template Service Tests**: ✅ **PASSING**

### **❌ REMAINING ISSUES**

#### **1. CLI Integration Broken**
- **Issue**: `minsky rules generate` command fails with import errors
- **Error**: `configurationService` not exported from configuration module
- **Location**: `src/domain/configuration/index.ts` missing export
- **Impact**: Command is completely non-functional

#### **2. Rules Command Tests Failing**
- **Location**: `src/adapters/shared/commands/rules.test.ts`
- **Issues**:
  - Massive test timeouts (4+ billion milliseconds)
  - `sharedCommandRegistry.clear is not a function` errors
  - Tests completely broken with Bun test framework
- **Status**: ❌ **0 passing, multiple timeouts**

#### **3. Mock System Incompatibility**
- **Issue**: Tests written for Jest but running on Bun
- **Impact**: Mock syntax incompatibilities causing test failures
- **Required**: Convert all Jest mocks to Bun test format

#### **4. Configuration Service Integration**
- **Issue**: Missing service instantiation and exports
- **Impact**: CLI commands cannot access configuration
- **Required**: Export `configurationService` from domain index

## **🚧 IMMEDIATE WORK REQUIRED**

### **Priority 1: Fix CLI Integration**
```typescript
// Fix: src/domain/configuration/index.ts
export { configurationService } from './config-service'; // MISSING
```

### **Priority 2: Fix Rules Command Tests**
```bash
# Current status: All failing with timeouts
bun test src/adapters/shared/commands/rules.test.ts
# Expected: All tests passing within normal timeouts
```

### **Priority 3: Complete Mock Conversion**
- Convert all `jest.mock()` to `mock.module()`
- Convert all `jest.fn()` to `mock()`
- Fix variable naming conflicts causing infinite loops

### **Priority 4: Integration Testing**
- Test `minsky rules generate` end-to-end
- Verify generated rules are valid
- Test all CLI options work properly

## **🎯 Success Criteria - PARTIAL COMPLETION**

- ✅ All existing rule content can be generated via template system
- ✅ Rules conditionally reference CLI commands or MCP tools based on configuration
- ❌ `minsky rules generate` command successfully generates and installs rules **BROKEN**
- ❌ Init command integrates with new template system maintaining backward compatibility **UNTESTED**
- ✅ Generated rules maintain the same effectiveness as current static rules
- ✅ Template system supports all current rule types and metadata
- ❌ Comprehensive test coverage for template generation and rule installation **FAILING**
- ✅ Documentation clearly explains template system and generation options

## **📊 Current Implementation Statistics**

- **Lines of Code**: ~1,500 lines implemented
- **Test Coverage**: Template system passing, CLI integration failing
- **Templates Created**: ✅ 8 comprehensive default templates
- **Command Options**: ✅ 10+ CLI options implemented (but broken)
- **Interface Support**: ✅ Full CLI, MCP, and Hybrid mode support (in theory)

## **🔥 Critical Issues Summary**

1. **CLI Command Completely Broken**: Missing configuration service export
2. **Test Suite Failing**: Jest/Bun mock incompatibilities and timeouts
3. **Integration Untested**: No end-to-end verification of rule generation
4. **Variable Naming Issues**: Causing infinite loops in some test scenarios

## **✅ What Works**
- Core template system logic
- Template loading and parsing
- Command generation algorithms
- Individual template unit tests

## **❌ What's Broken**
- CLI command execution
- Rules command tests
- End-to-end integration
- Configuration service access

## **📝 Next Steps**

1. **Fix configuration export** to enable CLI functionality
2. **Convert Jest mocks to Bun** to fix test timeouts
3. **Test CLI integration** end-to-end
4. **Verify init command** still works with template system
5. **Document remaining limitations** and create follow-up tasks

## **Task #289 Status: IMPLEMENTATION BLOCKED**

Core template system is complete but critical integration issues prevent the feature from being usable. CLI integration must be fixed before task can be considered complete.