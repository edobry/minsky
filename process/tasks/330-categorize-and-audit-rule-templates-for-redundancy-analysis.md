# Categorize and audit rule templates for redundancy analysis

## Status

TODO

## Priority  

MEDIUM

## Description

Implement a comprehensive categorization system for all existing rules and templates to enable analysis of redundancy, duplication, deprecation, and verbosity. This foundational work prepares for rule library optimization and cleanup.

## Context

Task #289 successfully implemented a template-based rules generation system with 8 core workflow templates. However, the broader rule ecosystem contains 64+ static rules that lack proper categorization, leading to potential redundancy and maintenance challenges. Before building a full rule library system (Task #048), we need to understand and organize what we have.

## Objectives

1. **Categorize all existing rules and templates** using a systematic tagging approach
2. **Audit for redundancy and duplication** across the rule ecosystem  
3. **Identify deprecated or outdated rules** that need updating or removal
4. **Analyze verbosity and consolidation opportunities** 
5. **Create foundation for rule library system** with proper metadata

## Scope

### In Scope
- All existing static rules in `.cursor/rules/` (~64 files)
- All template definitions in `src/domain/rules/default-templates.ts` (8 templates)
- Rule metadata and categorization system design
- Redundancy analysis and documentation
- Recommendations for cleanup and consolidation

### Out of Scope  
- Actual rule consolidation/removal (separate follow-up task)
- Full rule library implementation (Task #048)
- New template creation beyond categorization needs

## Requirements

### 1. Design Categorization System

- **Rule Categories**: Define logical groupings (workflow, tools, languages, project-types, etc.)
- **Tag Schema**: Create comprehensive tagging system for fine-grained classification
- **Metadata Format**: Extend existing frontmatter to include categories and tags
- **Hierarchy**: Support both broad categories and specific tags

**Example Category Schema:**
```yaml
categories:
  - workflow        # Core workflow rules (task-implementation, session-management)
  - tools          # Tool-specific rules (git, docker, testing)
  - languages      # Language-specific rules (typescript, python, rust)
  - project-types  # Project type rules (cli, web-app, library)
  - meta          # Rules about rules (rule-creation, cursor-setup)
  - deprecated    # Outdated rules marked for review/removal

tags:
  - task-management, session, git, testing, ai, mcp, cli, backend, frontend, etc.
```

### 2. Implement Categorization Tooling

- **Automated Analysis**: Script to scan and categorize existing rules based on content
- **Interactive Categorization**: Tool to manually review and tag rules
- **Validation**: Ensure all rules have proper categories and tags
- **Reporting**: Generate categorization coverage and health reports

**Implementation Approach:**
```typescript
// Rule analysis toolkit
interface RuleMetadata {
  name: string;
  description: string;
  categories: string[];
  tags: string[];
  lifecycle: 'active' | 'deprecated' | 'experimental';
  redundancy_risk: 'low' | 'medium' | 'high';
  verbosity_score: number; // 1-5 scale
  related_rules: string[];
  cli_commands: string[]; // Extracted CLI command references
  content_hash: string; // For similarity detection
}

// Analysis functions
function analyzeRuleContent(filePath: string): RuleMetadata;
function detectRedundancy(rules: RuleMetadata[]): RedundancyReport;
function suggestCategories(content: string): string[];
```

### 3. Comprehensive Rule Audit

- **Content Analysis**: Identify overlapping or duplicate content using text similarity
- **Command Pattern Analysis**: Find rules referencing same CLI commands/workflows
- **Freshness Assessment**: Identify outdated or deprecated rules based on last updates
- **Verbosity Analysis**: Flag rules that could be consolidated or simplified

**Audit Areas:**
- Rules with >80% content similarity
- Rules referencing identical CLI command patterns  
- Rules not updated in 6+ months
- Rules >500 lines that could be split or simplified
- Rules with overlapping workflow coverage

### 4. Documentation and Reporting

- **Category Documentation**: Document the categorization system and rationale
- **Audit Report**: Comprehensive analysis of redundancy and optimization opportunities
- **Migration Guide**: Prepare for potential rule consolidation work
- **Metrics Dashboard**: Track categorization progress and rule health

## Technical Implementation

### Phase 1: Categorization System Design (3-4 days)
1. Analyze existing rules to understand content patterns
2. Design category schema and tag taxonomy
3. Create metadata format and validation rules
4. Document categorization guidelines

### Phase 2: Tooling Development (4-5 days)
1. Build rule scanning and analysis scripts
2. Implement content similarity detection
3. Create interactive categorization interface
4. Add validation and reporting tools

### Phase 3: Rule Analysis and Categorization (6-7 days)
1. Scan and auto-categorize all existing rules
2. Manual review and refinement of categories/tags
3. Generate comprehensive redundancy analysis
4. Document optimization opportunities

### Phase 4: Documentation and Recommendations (2-3 days)
1. Create categorization system documentation
2. Generate final audit report with specific recommendations
3. Prepare migration/cleanup guidelines
4. Document rule library foundation

## Success Criteria

- [ ] **All 64+ existing rules have categories and tags assigned**
- [ ] **Categorization system is well-documented and extensible**  
- [ ] **Automated tooling can analyze and report on rule ecosystem health**
- [ ] **Comprehensive audit report identifies specific redundancy and optimization opportunities**
- [ ] **Foundation is prepared for rule library system implementation**
- [ ] **Clear recommendations for rule cleanup and consolidation**
- [ ] **Duplicate and redundant rules are identified and documented**
- [ ] **Verbosity metrics show improvement opportunities**

## Deliverables

1. **Categorization System Design** (`docs/rules/categorization-system.md`)
2. **Categorization Tooling** (`scripts/rule-analysis/` directory with analysis tools)
3. **Updated Rule Metadata** (All rule files with proper frontmatter)
4. **Comprehensive Audit Report** (`docs/rules/rule-ecosystem-audit.md`)
5. **Cleanup Recommendations** (`docs/rules/consolidation-plan.md`)

## Dependencies

- ✅ Task #289 (Template System) - COMPLETE
- Access to existing rule files in `.cursor/rules/`
- Understanding of current Minsky workflows and commands

## Estimated Effort

- **Research and Design**: 3-4 days
- **Tool Implementation**: 4-5 days  
- **Rule Analysis and Categorization**: 6-7 days
- **Documentation and Reporting**: 2-3 days
- **Total**: 15-19 days (3-4 weeks)

## Follow-up Tasks

This task sets up for:
- Rule consolidation and cleanup implementation
- Rule library system development (Task #048)
- Template-based rule migration
- Community rule contribution guidelines

## Notes

This focused approach builds directly on the template system from Task #289 and provides the analytical foundation needed before implementing the broader rule library system (Task #048). By starting with categorization and analysis, we can make data-driven decisions about rule optimization and library design.
