# Establish a Rule Library System

## Context

Minsky currently installs a fixed set of rules when initializing projects with `minsky init`. As the Minsky ecosystem grows, the rules become more numerous and diverse, requiring a more flexible system for managing, versioning, and distributing these rules. A dedicated rule library system would allow projects to select and install rules that are relevant to their specific stack and priorities, while also enabling easier contribution, versioning, and updates to rules.

## Requirements

1. **Research & Design**

   - Investigate and document approaches to rule library management
   - Determine optimal repository structure (standalone vs. part of Minsky core)
   - Research versioning schemes for rules and rule sets
   - Define a protocol for rule discovery, validation, and installation
   - Design an extensible metadata format for rules using zod-matter
   - Consider integration with existing `minsky rules` subcommands

2. **Rule Organization & Categorization**

   - Design a categorical structure for organizing rules (e.g., by domain, language, toolset)
   - Create a system of tags or attributes for rule discovery
   - Design a mechanism for defining rule dependencies and conflicts
   - Support bundling commonly used rules into "rule sets" for specific technologies or workflows

3. **Installation & Update Mechanisms**

   - Enhance `minsky init` to install a customizable subset of rules
   - Design rule update mechanisms to maintain rules in existing projects
   - Support checking for rule updates and conflicts
   - Establish a method for progressive rule adoption in existing projects

4. **Contribution System**

   - Design a contribution framework for rule authors
   - Define validation standards and quality checks for contributed rules
   - Create templates and guidelines for rule creation
   - Support for community rules alongside official rules

5. **Versioning & Compatibility**

   - Create a versioning scheme for individual rules
   - Design a mechanism for tracking rule compatibility with Minsky versions
   - Support pinning rule versions to ensure stability
   - Allow for deprecation and replacement of rules

6. **Rule Generation**
   - Implement support for programmatic rule generation
   - Leverage zod-matter for schema validation and YAML frontmatter generation
   - Create utilities for generating rule boilerplate
   - Support template substitution for rule content

## Implementation Steps

1. [ ] Research Phase:

   - [ ] Document existing rule structures and metadata
   - [ ] Investigate repository approaches (mono-repo, separate repo, etc.)
   - [ ] Survey analogous systems in other tools for inspiration
   - [ ] Create a design document outlining the chosen approach

2. [ ] Core Architecture:

   - [ ] Define rule library repository structure
   - [ ] Design rule metadata schema with zod-matter
   - [ ] Implement rule validation utilities
   - [ ] Create rule categorization system

3. [ ] Integration with Minsky:

   - [ ] Extend `minsky init` to support rule library integration
   - [ ] Add rule discovery and installation functionality
   - [ ] Implement rule update commands
   - [ ] Design compatibility checking system

4. [ ] Rule Management System:

   - [ ] Create CLI commands for rule installation, update, and removal
   - [ ] Implement rule dependency resolution
   - [ ] Add support for rule sets (collections of related rules)
   - [ ] Create interfaces for rule management

5. [ ] Rule Generation Utilities:

   - [ ] Implement programmatic rule creation tools
   - [ ] Create templates for common rule types
   - [ ] Build frontmatter generation tools with zod-matter
   - [ ] Design rule testing and validation framework

6. [ ] Documentation and Examples:
   - [ ] Comprehensive documentation for rule library usage
   - [ ] Examples of rule creation and contribution
   - [ ] Guidelines for rule design and best practices
   - [ ] Sample rule sets for common technologies

## Verification

- [ ] The rule library system correctly organizes rules by category, domain, and purpose
- [ ] The `minsky init` command can install a customizable subset of rules
- [ ] Rule metadata is validated using zod-matter
- [ ] Rules can be versioned, updated, and managed
- [ ] Rules can depend on other rules and detect conflicts
- [ ] Rule sets can be defined and installed as units
- [ ] Rule generation utilities create valid rule files
- [ ] The system is compatible with existing `minsky rules` commands
- [ ] Documentation is comprehensive and clear

## Relation to Existing Components

- This task expands upon the `minsky init` command's current rule installation capabilities
- It should be compatible with the planned `minsky rules` commands from task #029
- The rule library should support existing rule formats and conventions
- The system should work with both Cursor and generic AI rule formats

## Technical Considerations

- **Storage Location**: Consider using a dedicated package, GitHub repository, or registry
- **Update Mechanism**: Determine whether to use a package manager, Git, or custom solution
- **Versioning**: Design a semantic versioning scheme for rules and rule sets
- **Performance**: Ensure rule discovery and installation is efficient
- **Backward Compatibility**: Maintain compatibility with existing rules in projects
- **Security**: Implement verification of rule sources and content

## RFC: Establishing a Rule Library System for Minsky

### Executive Summary

This RFC proposes a Git-based approach to establishing a Rule Library System for Minsky. The system aims to address the current limitation where Minsky installs a fixed set of rules during project initialization, instead creating a flexible framework that enables rule discovery, versioning, categorization, and distribution. The proposal focuses on a streamlined approach with minimal metadata requirements that can be enhanced over time as new use cases emerge.

### Background

#### Current State of Rules in Minsky

Minsky currently employs rules as an integral part of its workflow. Rules serve as guidelines and protocols that AI coding assistants follow when working with codebases. These rules are:

1. Currently installed as a fixed set during `minsky init`
2. Stored in either `.cursor/rules` or `.ai/rules` directories depending on format
3. Managed through basic `minsky rules` commands for listing, getting, creating, updating, and searching
4. Formatted as `.mdc` files with YAML frontmatter containing metadata

The current implementation, while functional, lacks scalability as the Minsky ecosystem grows and lacks flexibility for projects with different needs.

#### Problems to Solve

1. **Scale**: As the number of rules increases, managing them becomes more challenging
2. **Customization**: Different projects may need different subsets of rules
3. **Versioning**: Rules evolve over time and need proper versioning
4. **Discoverability**: Finding relevant rules is currently difficult
5. **Distribution**: No standard way to share rules across projects
6. **Organization**: No formal categorization system exists for rules

### Research Findings

#### Git-Based Approaches

Git repositories offer several advantages for rule management:

1. **Built-in versioning**: Git's version control capabilities are ideal for tracking rule changes
2. **Familiar workflow**: Most developers already understand Git-based workflows
3. **Pull request model**: Enables contribution, review, and quality control
4. **Branch management**: Supports experimental and stable versions of rules
5. **Simple distribution**: Rules can be pulled directly from repositories

#### Generic Package Management Systems

Several language-agnostic package management approaches exist:

1. **OCI Artifacts**: The Open Container Initiative (OCI) introduced standards for storing non-container artifacts in container registries
2. **Helm Registry**: Stores Helm charts using OCI registries
3. **ORAS (OCI Registry As Storage)**: Allows storing any type of artifact in OCI registries

These generic packaging solutions offer standardized ways to store and distribute artifacts but may be more complex than needed initially.

### Proposed Approach

We recommend a **Git-based approach** with the following components:

#### 1. Repository Structure

**Option A: Rules in Minsky Core Repository**

- Store rules in a dedicated `rules/` directory of the Minsky repository (not in `.cursor/rules`)
- This directory becomes the canonical source of truth for rules
- The `.cursor/rules` directory would be just another "install target"
- Pros:
  - Simpler development workflow
  - Rules are versioned alongside core Minsky code
  - No synchronization issues between repositories
- Cons:
  - Repository size increases over time
  - Less separation of concerns
  - More difficult to have community-contributed rules

**Option B: Dedicated Rule Repository**

- Create a separate repository (e.g., `minsky-rules`)
- Pros:
  - Cleaner separation of concerns
  - Better suited for community contributions
  - Independent versioning from core Minsky code
- Cons:
  - Requires synchronization between repositories
  - More complex development workflow
  - Dependency management between Minsky and rules

**Implementation Decision:** Start with Option A (rules in core Minsky repository). Create a dedicated `rules/` directory at the root of the repository organized by category. This directory will be the source of truth for rules, while `.cursor/rules` and `.ai/rules` will be treated as installation targets.

#### 2. Minimal Metadata Schema

Use a simple metadata schema initially, with room to expand:

```yaml
---
name: rule-name
description: Short description of what the rule does
version: 0.1.0
categories: [workflow, code-organization] # Primary categorization
subcategories: [git-workflow, module-structure] # Optional sub-categorization
author: Minsky Team
required: false # Whether this rule is required for all projects
dependencies: [] # Optional list of rule IDs this rule depends on
---
```

**Implementation Notes:**

- Use zod-matter to define and validate this schema
- Only `name`, `description`, and `categories` are required fields initially
- Add validation to ensure categories are from the predefined list
- Store the schema definition in `src/domain/rules/schema.ts`

#### 3. Development Workflow

For Minsky core development, the workflow would be:

1. Rules are edited directly in the `rules/` directory (canonical source)
2. Changes to rules are committed along with code changes
3. A build/copy script updates rules in `.cursor/rules` for local development testing
4. Integration tests verify that rules are correctly loaded, validated, and installed

**Implementation Notes:**

- Create a simple build script that copies rules from `rules/` to `.cursor/rules`
- Add this script to the development workflow documentation
- Add integration tests that verify rule loading, validation, and installation

For users:

1. `minsky init` installs default rules from the bundled rule library
2. `minsky rules update` pulls latest rules from the configured source
3. `minsky rules install <rule-id>` adds a specific rule

#### 4. Rule Versioning

**Implementation Decision:** Start with coupled versioning. Each rule will have a version field, but it will initially match the Minsky version. This simplifies the initial implementation while allowing for independent versioning in the future.

Implementation considerations:

- Store the Minsky version in a central location
- Reference this version when generating rule metadata
- Add version compatibility checking to rule loading logic
- Document the version coupling in the codebase

#### 5. Rule Format

We recommend maintaining the `.mdc` format with YAML frontmatter for rules:

- Pros:
  - Simple and readable
  - Compatible with existing tools
  - Easily editable by humans
  - YAML frontmatter provides structured metadata
- Cons:
  - Limited dynamic generation capabilities
  - No compile-time validation

**Implementation Notes:**

- Use the existing `.mdc` format with enhanced metadata
- Add runtime validation for rule content and metadata
- Implement proper error handling for malformed rules
- Store validation logic in `src/domain/rules/validation.ts`

#### 6. Command Structure

The `minsky rules` command structure will include:

```
minsky rules list [--category <category>] [--json]
minsky rules get <rule-id>
minsky rules install <rule-id>
minsky rules update [<rule-id>|--all]
minsky rules uninstall <rule-id>
```

The `minsky init` command will be enhanced to support rule selection:

```
minsky init [--rule-set <set-name>] [--include-rule <rule-id>] [--exclude-rule <rule-id>]
```

**Implementation Priority:**

1. First implement `rules list` and `rules get` commands
2. Then enhance `minsky init` to support rule selection
3. Finally implement `rules install`, `update`, and `uninstall` commands

**Implementation Notes:**

- Follow the existing command structure pattern in `src/commands/`
- Separate business logic into domain modules in `src/domain/rules/`
- Add comprehensive tests for each command
- Implement proper error handling and user feedback

#### 7. Categorization Structure

We will use a two-level categorization system:

**Core Categories:**

- `workflow`: Rules about process and workflows
  - `git-workflow`: Git-specific workflow rules
  - `task-management`: Task management workflow rules
- `code-organization`: Rules about structuring code
  - `module-structure`: How to organize modules
  - `naming-conventions`: Naming patterns and conventions
- `quality`: Rules about code quality and testing
  - `testing`: Test writing and structure
  - `error-handling`: Error handling patterns
  - `logging`: Logging standards
- `documentation`: Rules about documentation standards
  - `comments`: Code comment standards
  - `docs`: Documentation file standards
- `tooling`: Rules about development tools
  - `editor`: Editor-specific rules
  - `build`: Build system rules

**Implementation Notes:**

- Define these categories as constants in `src/domain/rules/constants.ts`
- Create directory structure in `rules/` matching these categories
- Add validation to ensure rules are placed in the correct directories
- Implement filtering by category in the `rules list` command

### Implementation Plan and Guidelines

#### Phase 1: Foundation (Start Here)

1. **Create Repository Structure** (Priority: High)

   - [ ] Create `rules/` directory at the repository root
   - [ ] Set up category subdirectories based on the categorization structure
   - [ ] Establish a clear distinction between source and target directories
   - [ ] Move existing rules from `.cursor/rules` to appropriate category directories in `rules/`

2. **Define Metadata Schema** (Priority: High)

   - [ ] Implement the minimal metadata schema using zod-matter in `src/domain/rules/schema.ts`
   - [ ] Create validation functions for rule metadata
   - [ ] Add tests for schema validation
   - [ ] Update existing rules with the new metadata format

3. **Rule Loading and Validation** (Priority: High)
   - [ ] Implement rule loading functions in `src/domain/rules/loader.ts`
   - [ ] Add validation for rule content and structure
   - [ ] Create error handling for malformed rules
   - [ ] Write tests for rule loading and validation

#### Phase 2: Management Commands (Start after Phase 1 is complete)

1. **Basic Rule Commands** (Priority: Medium)

   - [ ] Implement `minsky rules list` with category filtering
   - [ ] Implement `minsky rules get` to display a specific rule
   - [ ] Add JSON output option to both commands
   - [ ] Add comprehensive tests for both commands

2. **Init Command Enhancement** (Priority: Medium)

   - [ ] Enhance `minsky init` to support rule selection
   - [ ] Add support for rule sets (predefined collections of rules)
   - [ ] Implement include/exclude rule options
   - [ ] Add tests for the enhanced init command

3. **Advanced Rule Commands** (Priority: Low)
   - [ ] Implement `minsky rules install` command
   - [ ] Implement `minsky rules update` command
   - [ ] Implement `minsky rules uninstall` command
   - [ ] Add tests for all commands

#### Phase 3: Distribution and Integration (Future)

1. **Git Integration** (Priority: Low)

   - [ ] Add support for pulling rules from remote Git repositories
   - [ ] Implement authentication handling for private repositories
   - [ ] Create mechanisms for rule version compatibility checking
   - [ ] Add tests for Git integration

2. **Rule Sets and Dependencies** (Priority: Low)
   - [ ] Implement rule dependency resolution
   - [ ] Create predefined rule sets for common scenarios
   - [ ] Add validation for rule dependencies
   - [ ] Add tests for dependency resolution

### Testing Strategy

1. **Unit Tests**

   - Test rule parsing and validation logic
   - Test metadata schema validation
   - Test category and dependency resolution
   - Test command argument parsing

2. **Integration Tests**

   - Test rule loading from source directory
   - Test rule installation to target directories
   - Test rule update and uninstallation
   - Test init command with rule selection

3. **End-to-End Tests**
   - Test the complete workflow from init to rule management
   - Test with various rule configurations
   - Test error cases and recovery

### Potential Challenges and Mitigations

1. **Version Compatibility**

   - Challenge: Handling version mismatches between rules and Minsky
   - Mitigation: Start with coupled versioning and add clear error messages for version mismatches

2. **Rule Dependencies**

   - Challenge: Circular dependencies could be an issue
   - Mitigation: Implement dependency validation during rule installation and update

3. **Installation Paths**

   - Challenge: Various OS-specific file paths will need proper handling
   - Mitigation: Use Node.js path utilities and test on multiple platforms

4. **Migration**
   - Challenge: Existing projects will need a migration path
   - Mitigation: Create a migration command or script to update existing rule installations

### Conclusion

The Git-based approach offers a familiar, proven system for rule management that can start simple and evolve over time. By focusing on minimal metadata and leveraging existing Git workflows, we can deliver a functional rule library system quickly while establishing a foundation for future enhancements.

This approach balances immediate needs with long-term scalability, providing a foundation that can evolve as the Minsky ecosystem grows and matures.

## Related Future Tasks

### Task: Explore OCI Artifacts for Rule Distribution

As the Minsky rule ecosystem grows, we should investigate using OCI Artifacts as a standardized distribution mechanism. OCI (Open Container Initiative) Artifacts provide a language-agnostic approach to artifact storage and distribution that could benefit our rule library system.

#### Requirements:

1. Research OCI Artifacts specification and implementations
2. Prototype rule storage and retrieval using OCI registries
3. Compare with Git-based approach in terms of usability, performance, and integration complexity
4. Evaluate authentication and security considerations
5. Design a migration path from Git-based to OCI-based distribution if deemed beneficial

### Task: Implement TypeScript-based Rule Authoring System

To address the limitations of static `.mdc` files, we should develop a TypeScript-based rule authoring system that enables dynamic content generation while maintaining compatibility with the existing rule format.

Note: This task is deferred to a future implementation phase. The current implementation should focus on the core Git-based rule library system with the `.mdc` format.
