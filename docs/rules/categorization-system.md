# Rule Categorization System

## Overview

This document defines the comprehensive categorization system for organizing and managing Minsky's rule ecosystem. Based on analysis of 64+ existing rules, this system provides logical groupings, tagging schemas, and metadata frameworks to enable effective rule discovery, redundancy analysis, and maintenance.

## Core Categories

### 1. **workflow** - Core Workflow Rules
Rules that define fundamental processes and workflows for using Minsky.

**Characteristics:**
- Define step-by-step processes
- Include lifecycle management
- Cover task-to-completion workflows
- Essential for new users

**Examples:**
- minsky-workflow
- task-implementation-workflow  
- pr-preparation-workflow
- session-first-workflow

### 2. **tools** - Tool-Specific Rules
Rules focused on specific tools, CLI commands, or external integrations.

**Characteristics:**
- Tool-specific guidance
- CLI command references
- Integration patterns
- Environment setup

**Examples:**
- git-usage-policy
- bun_over_node
- cli-testing
- mcp-usage

### 3. **testing** - Testing and Quality Assurance
Rules covering testing methodologies, patterns, and quality assurance practices.

**Characteristics:**
- Testing strategies and patterns
- Quality gates and verification
- Test automation approaches
- Debugging methodologies

**Examples:**
- test-driven-bugfix
- testing-boundaries
- framework-specific-tests
- test-expectations

### 4. **organization** - Code Organization and Architecture
Rules for structuring code, modules, and architectural decisions.

**Characteristics:**
- Code structure guidelines
- Architectural patterns
- Module organization
- Design principles

**Examples:**
- domain-oriented-modules
- command-organization
- architectural-bypass-prevention
- code-organization-router

### 5. **documentation** - Documentation and Communication
Rules for creating, maintaining, and formatting documentation.

**Characteristics:**
- Documentation standards
- Communication guidelines
- Change documentation
- Knowledge sharing

**Examples:**
- changelog
- pr-description-guidelines
- rule-creation-guidelines
- comments

### 6. **meta** - Rules About Rules
Rules that govern the rule system itself, including creation, management, and meta-processes.

**Characteristics:**
- Rule system management
- Template systems
- Rule creation standards
- Self-referential guidance

**Examples:**
- rule-creation-guidelines
- rules-management
- derived-cursor-rules
- resource-management-protocol

### 7. **quality** - Code Quality and Standards
Rules enforcing code quality, error handling, and development standards.

**Characteristics:**
- Quality standards
- Error handling patterns
- Code review standards
- Best practices enforcement

**Examples:**
- robust-error-handling
- dont-ignore-errors
- variable-naming-protocol
- ai-linter-autofix-guideline

### 8. **project-types** - Project-Specific Guidance
Rules tailored to specific types of projects or development contexts.

**Characteristics:**
- Context-specific guidance
- Project type patterns
- Domain-specific rules
- Specialized workflows

**Examples:**
- cli-bridge-development
- automation-approaches
- codemods-development-standards

## Tag Schema

### Primary Tags (Tool/Technology Focus)
- `minsky` - Core Minsky functionality
- `git` - Git workflow and operations
- `bun` - Bun-specific guidance
- `cli` - Command-line interface development
- `mcp` - Model Context Protocol
- `ai` - AI/LLM integration
- `docker` - Containerization
- `testing` - Test-related

### Process Tags (Workflow Stage)
- `setup` - Initial setup and configuration
- `development` - Development process
- `review` - Code review process
- `deployment` - Deployment and release
- `maintenance` - Ongoing maintenance

### Scope Tags (Applicability)
- `core` - Essential/foundational rules
- `optional` - Nice-to-have rules
- `advanced` - Advanced/specialized rules
- `deprecated` - Outdated rules marked for review

### Context Tags (When to Apply)
- `always` - Always applicable
- `project-start` - Apply when starting new projects
- `feature-development` - Apply during feature development
- `bug-fixing` - Apply when fixing bugs
- `refactoring` - Apply during refactoring

### Domain Tags (Technical Area)
- `backend` - Backend/server-side
- `frontend` - Frontend/client-side
- `database` - Database-related
- `api` - API development
- `ui` - User interface
- `automation` - Automation and scripting

## Metadata Format

### Extended Frontmatter Schema

```yaml
---
# Basic Information
name: "Rule Display Name"
description: "Brief description of the rule's purpose"

# Categorization
categories:
  - workflow
  - tools
tags:
  - minsky
  - git
  - core

# Lifecycle Management
lifecycle: active | deprecated | experimental
created_date: "2024-01-01"
last_updated: "2024-01-15"
version: "1.2.0"

# Relationships
related_rules:
  - rule-name-1
  - rule-name-2
supersedes:
  - old-rule-name
dependencies:
  - required-rule-name

# Usage Metadata
applies_to:
  - interface: ["cli", "mcp", "hybrid"]
  - project_types: ["library", "cli-app", "web-app"]
frequency: high | medium | low
complexity: basic | intermediate | advanced

# Quality Metrics
redundancy_risk: low | medium | high
verbosity_score: 1-5
maintenance_burden: low | medium | high

# Discovery
keywords:
  - session
  - workspace
  - implementation
search_terms:
  - "how to start session"
  - "workspace setup"
---
```

### Required Fields
- `name` - Human-readable rule name
- `description` - Brief purpose description
- `categories` - Array of primary categories (1-3)
- `tags` - Array of relevant tags (3-8)
- `lifecycle` - Current lifecycle state

### Optional Fields
- `related_rules` - Linked rules
- `applies_to` - Usage context
- `frequency` - How often rule is used
- `complexity` - Difficulty level
- `keywords` - SEO/discovery terms

## Usage Guidelines

### For Rule Authors

1. **Choose 1-3 Primary Categories**
   - Select the most relevant category
   - Add 1-2 secondary categories if truly applicable
   - Avoid over-categorization

2. **Select 3-8 Relevant Tags**
   - Include tool/technology tags
   - Add process/workflow tags
   - Include scope/context tags
   - Avoid tag spam

3. **Provide Complete Metadata**
   - Always include required fields
   - Add optional fields that aid discoverability
   - Update metadata when rule content changes

### For Rule Consumers

1. **Browse by Category**
   - Start with primary categories for broad discovery
   - Use category combinations for specific needs

2. **Filter by Tags**
   - Use tool tags to find technology-specific rules
   - Use scope tags to find rules for your experience level
   - Use context tags to find rules for your current task

3. **Follow Related Rules**
   - Check `related_rules` for comprehensive guidance
   - Follow `dependencies` for prerequisite rules
   - Avoid `supersedes` rules in favor of current versions

## Implementation Strategy

### Phase 1: Core Infrastructure
1. Define metadata schema and validation
2. Create categorization tooling
3. Establish category and tag standards

### Phase 2: Automated Analysis
1. Scan existing rules for content patterns
2. Suggest initial categorizations
3. Identify redundancy and consolidation opportunities

### Phase 3: Manual Curation
1. Review and refine automated suggestions
2. Apply categorization to all existing rules
3. Validate categorization consistency

### Phase 4: Maintenance Processes
1. Establish ongoing categorization guidelines
2. Create validation tools for new rules
3. Set up automated categorization for templates

## Validation Rules

### Category Validation
- Maximum 3 categories per rule
- At least 1 category required
- Categories must be from approved list

### Tag Validation
- 3-8 tags per rule recommended
- Tags should span multiple tag types
- Avoid redundant or contradictory tags

### Relationship Validation
- Related rules must exist
- No circular dependencies
- Superseded rules should be marked deprecated

## Benefits

### For Users
- **Faster Discovery** - Find relevant rules quickly
- **Reduced Cognitive Load** - Clear organization reduces overwhelm  
- **Progressive Learning** - Start with core rules, advance gradually
- **Context Awareness** - Find rules for specific situations

### For Maintainers
- **Redundancy Detection** - Identify overlapping rules
- **Impact Analysis** - Understand rule relationships
- **Quality Metrics** - Track rule health and usage
- **Automated Management** - Enable tooling for rule operations

### For System Evolution
- **Strategic Planning** - Understand rule ecosystem gaps
- **Deprecation Management** - Systematic rule lifecycle
- **Template Generation** - Categorized rule templates
- **Community Contribution** - Clear guidelines for new rules

## Migration Strategy

### Existing Rules
1. **Automated Categorization** - Use content analysis for initial suggestions
2. **Manual Review** - Human review and refinement of categorization
3. **Gradual Application** - Apply categorization in batches
4. **Validation** - Verify categorization accuracy and consistency

### New Rules
1. **Template Integration** - Include categorization in rule templates
2. **Creation Workflow** - Require categorization during rule creation
3. **Validation Tools** - Automated checking of categorization standards
4. **Review Process** - Include categorization in rule review checklist

This categorization system provides the foundation for organizing Minsky's rule ecosystem, enabling better discovery, maintenance, and evolution of the rule library. 
