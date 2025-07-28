# Implement Template-Based Rules Generation System

## Status

IN-PROGRESS

## Priority

MEDIUM

## Description

# Task #289: Implement Template-Based Rules Generation System ⚠️ IN-PROGRESS

## Context

Currently, Minsky rules are static `.mdc` files with hardcoded CLI command references. The `init` command generates rules using static content functions in `src/domain/init.ts`, and there's no way to conditionally reference CLI commands vs MCP tool calls based on project configuration. This limits the flexibility of rules and prevents optimal integration with different interface types (CLI vs MCP).

As the MCP ecosystem grows and rules become more sophisticated, we need a templating system that can:

1. ✅ Generate rules dynamically based on project configuration
2. ⚠️ Conditionally reference CLI commands or MCP tool calls (infrastructure ready, rules not converted)
3. ✅ Support template variables and dynamic content generation
4. ✅ Maintain the existing `.mdc` format for compatibility

## Implementation Status

### ✅ Phase 1: Investigation and Architecture (COMPLETED)

1. **Current State Analysis** ✅

   - ✅ Analyzed all current rules for CLI command patterns
   - ✅ Created mapping of CLI commands to MCP tool equivalents via CommandGeneratorService
   - ✅ Documented rule generation logic currently in init domain
   - ✅ Identified template variable needs for each rule

2. **Template System Design** ✅
   - ✅ Designed template literal architecture for rules
   - ✅ Created interfaces for rule generation configuration (RuleGenerationConfig)
   - ✅ Designed template registry and composition system (RuleTemplateService)
   - ✅ Planned conditional content generation patterns

### ✅ Phase 2: Rules Domain Enhancement (COMPLETED)

1. **Extract Init Logic** ✅

   - ✅ Moved rule generation logic to rules domain
   - ✅ Created `RuleTemplateService` class in `src/domain/rules/rule-template-service.ts`
   - ✅ Implemented template registry and management
   - ✅ Added rule generation configuration interfaces

2. **Template Infrastructure** ✅
   - ✅ Implemented template literal evaluation system
   - ✅ Created template validation utilities
   - ✅ Added configuration-driven content generation
   - ✅ Implemented template composition patterns

### ⚠️ Phase 3: Template Conversion (PARTIALLY COMPLETED)

1. **Core Rule Templates** ⚠️ **INCOMPLETE**

   - ✅ Created MINSKY_WORKFLOW_TEMPLATE with dynamic CLI/MCP syntax
   - ✅ Created INDEX_TEMPLATE for rules navigation
   - ✅ Created MCP_USAGE_TEMPLATE for MCP integration guidance
   - ✅ Implemented dynamic command generator for CLI/MCP conversion
   - ❌ **CRITICAL MISSING**: Existing rule files (60+) still contain hardcoded CLI commands
   - ❌ **MAJOR WORK REMAINING**: Core workflow rules not converted to templates:
     - `minsky-workflow-orchestrator.mdc` (contains hardcoded `minsky tasks list`, `minsky git approve`)
     - `task-implementation-workflow.mdc` (contains hardcoded `minsky tasks get`, `minsky session dir`)
     - `minsky-cli-usage.mdc` (contains extensive CLI reference patterns)
     - `minsky-session-management.mdc` (session workflow commands)
     - `task-status-protocol.mdc` (status management commands)
     - `pr-preparation-workflow.mdc` (PR workflow commands)

2. **Command Reference Templates** ⚠️ **INCOMPLETE**
   - ✅ Created CommandGeneratorService with CLI command to MCP tool mapping
   - ✅ Templated sample workflow rules with command references
   - ✅ Added interface preference logic to command references
   - ❌ **CRITICAL GAP**: Existing rules not using template system
   - ❌ **MISSING**: Template versions of major workflow rules

### ✅ Phase 4: Rules Generation Command (COMPLETED)

1. **Core Command Implementation** ✅

   - ✅ Implemented `minsky rules generate` command with full options:
     - `--interface` (cli/mcp/hybrid)
     - `--rules` (rule selection)
     - `--output-dir` (custom output location)
     - `--dry-run` (preview generation)
     - `--overwrite` (force overwrite)
     - `--format`, `--prefer-mcp`, `--mcp-transport`, `--json`, `--debug`

2. **Integration and Testing** ✅
   - ✅ Added output directory and format options
   - ✅ Implemented comprehensive error handling
   - ✅ Created template validation and testing (40+ tests)
   - ✅ Added logging and progress feedback

### ✅ Phase 5: Init Command Integration (COMPLETED)

1. **Update Init Command** ✅
   - ✅ Integrated template system with init command
   - ✅ Configured rule generation based on init parameters
   - ✅ Maintained backward compatibility with existing functionality
   - ✅ Updated for new rule generation approach

### ✅ Phase 6: MCP XML Format Correction (COMPLETED)

**CRITICAL FIX IMPLEMENTED**: Corrected MCP tool invocation format to match AI agent requirements

1. **XML Format Implementation** ✅

   - ✅ Fixed `generateMcpSyntax` to use proper XML format:
     ```xml
     <function_calls>
     <invoke name="mcp_minsky-server_tasks_list">
     <parameter name="filter">optional filter value</parameter>
     </invoke>
     </function_calls>
     ```
   - ✅ Replaced incorrect function call syntax with XML structure
   - ✅ Ensured command ID conversion (dots → underscores)
   - ✅ Added proper parameter value hints (required/optional)

2. **Comprehensive Testing** ✅
   - ✅ Created 14 XML format test cases covering:
     - Commands with no parameters
     - Commands with optional parameters
     - Commands with required parameters
     - Commands with mixed parameters
     - Command ID conversion (tasks.status.get → mcp_minsky-server_tasks_status_get)
     - Special characters in parameter names
     - XML structure validation
   - ✅ All tests pass, confirming correct MCP format

## CRITICAL REMAINING WORK

### ❌ Phase 7: Rule Conversion (NOT STARTED - HIGH PRIORITY)

**MAJOR GAP**: 60+ existing rule files contain hardcoded CLI commands that need conversion

1. **Core Workflow Rules Conversion** ❌

   - ❌ Convert `minsky-workflow-orchestrator.mdc` to template
   - ❌ Convert `task-implementation-workflow.mdc` to template
   - ❌ Convert `minsky-session-management.mdc` to template
   - ❌ Convert `task-status-protocol.mdc` to template
   - ❌ Convert `pr-preparation-workflow.mdc` to template
   - ❌ Convert `minsky-cli-usage.mdc` to template

2. **Template Registry Expansion** ❌

   - ❌ Add templates for all major workflow rules
   - ❌ Update rule generation to use converted templates
   - ❌ Ensure template coverage matches existing functionality

3. **Hardcoded Command Replacement** ❌
   - ❌ Replace `minsky tasks list --json` with templated version
   - ❌ Replace `minsky session start --task <id>` with templated version
   - ❌ Replace `minsky git pr --task <id>` with templated version
   - ❌ Replace all workflow command references with template system

### ❌ Phase 8: Integration and Validation (NOT STARTED)

1. **End-to-End Testing** ❌

   - ❌ Test generated rules work in CLI mode
   - ❌ Test generated rules work in MCP mode
   - ❌ Test generated rules work in hybrid mode
   - ❌ Validate rule functionality matches original static rules

2. **Migration Path** ❌
   - ❌ Create migration strategy from static to templated rules
   - ❌ Update init command to generate all core rules from templates
   - ❌ Deprecate static rule generation functions

## Current Achievement Assessment

### What We Successfully Built ✅

- **Template Infrastructure**: Complete and robust
- **Command Generation**: Dynamic CLI/MCP syntax from shared registry
- **CLI Integration**: Fully functional `minsky rules generate` command
- **MCP Compliance**: Correct XML format for AI agents
- **Testing**: Comprehensive test coverage for infrastructure

### What We Haven't Achieved ❌

- **Main Goal**: Static rules are still static - they haven't been converted
- **Rule Conversion**: 0 of 60+ existing rules have been templated
- **Template Coverage**: Only 3 templates vs. ~15 needed for full workflow
- **CLI/MCP Adaptation**: Existing rules still show only CLI commands
- **Production Readiness**: Template system exists but isn't being used by core rules

## Success Criteria Assessment

- ❌ **All existing rule content can be generated via template system** - Only 3 demo templates exist
- ❌ **Rules can conditionally reference CLI commands or MCP tools** - Infrastructure ready, rules not converted
- ✅ **`minsky rules generate` command successfully generates and installs rules**
- ✅ **Init command integrates with new template system maintaining backward compatibility**
- ❌ **Generated rules maintain the same effectiveness as current static rules** - Core rules not templated yet
- ✅ **Template system supports all current rule types and metadata**
- ✅ **Comprehensive test coverage for template generation**
- ❌ **Template system replaces static rule generation** - Infrastructure exists but rules not converted

## Honest Status Assessment

**Infrastructure Complete**: ✅ The template system infrastructure is excellent and ready for production

**Primary Goal Achievement**: ❌ **The main deliverable - converting existing rules to use conditional CLI/MCP syntax - is not complete**

**Current State**: We have a sophisticated template system that could replace static rule generation, but the existing rules that users actually rely on haven't been converted to use it.

**Remaining Effort**: Substantial work remains to convert 60+ rule files and create templates for all major workflows.

The template system is ready, but Task #289's core objective - replacing static rule generation with dynamic, configuration-driven templates - requires significant additional work to convert existing rules.

## Next Steps for Completion

1. **Audit all existing rules** for CLI command patterns
2. **Create templates for core workflow rules** (minsky-workflow-orchestrator, task-implementation-workflow, etc.)
3. **Convert hardcoded CLI commands** to templated equivalents
4. **Test end-to-end rule generation** in CLI/MCP/hybrid modes
5. **Migrate rule generation** from static functions to template system

**Estimated Remaining Work**: 2-3 additional implementation phases to achieve the original goal.
