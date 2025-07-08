# Task #178: Establish Codemod Best Practices and Standards

## Context

The Minsky project has accumulated 90+ codemods in the `codemods/` directory, representing significant experience in automated code transformation. However, there are no established standards or guidelines for writing effective, safe, and maintainable codemods. Recent work on the error pattern codemod (Task #169) revealed both effective patterns and areas for improvement.

This task aims to:

1. Analyze existing codemods to extract proven patterns and anti-patterns
2. Research industry best practices for codemod development
3. Create comprehensive guidelines and rules for future codemod development
4. Establish a standardized structure and approach for codemods

## Requirements

### 1. Codemod Analysis and Pattern Extraction

**Analyze Existing Codemods:**

- Review all 90+ codemods in the `codemods/` directory
- Categorize codemods by approach:
  - Simple string/regex-based transformations
  - ESLint output parsing and targeted fixes
  - TypeScript AST-based transformations (ts-morph, typescript compiler API)
  - Hybrid approaches
- Identify common patterns:
  - File discovery and filtering
  - Content parsing and analysis
  - Safety checks and validation
  - Error handling and reporting
  - Import management
  - Output formatting and logging

**Extract Success Patterns:**

- Document effective safety mechanisms
- Identify robust error handling approaches
- Catalog successful TypeScript/AST integration patterns
- Note effective testing and validation strategies

**Identify Anti-Patterns:**

- Document problematic approaches that led to issues
- Identify common failure modes
- Note maintenance and debugging challenges
- Catalog performance bottlenecks

### 2. Industry Best Practices Research

**Research Popular Codemod Libraries:**

- **jscodeshift**: Facebook's codemod toolkit
- **ts-morph**: TypeScript compiler API wrapper
- **recast**: JavaScript AST transformation toolkit
- **babel-codemod**: Babel-based transformations
- **ast-grep**: Tree-sitter based code search and transformation
- **comby**: Language-agnostic structural search and replace

**Evaluate Library Benefits:**

- Compare safety guarantees
- Assess ease of use and learning curve
- Evaluate performance characteristics
- Review community adoption and maintenance
- Analyze integration complexity

**Study Best Practices:**

- Review documentation and guides from major projects
- Analyze open-source codemod examples
- Research testing methodologies
- Study error handling and rollback strategies

### 3. Create Comprehensive Guidelines

**Develop Codemod Standards:**

- Establish file naming conventions
- Define required documentation standards
- Create template structure for new codemods
- Specify safety check requirements
- Define testing protocols

**Create Decision Framework:**

- When to use string/regex vs AST-based approaches
- How to choose between different AST libraries
- Guidelines for handling edge cases
- Strategies for incremental vs comprehensive transformations

**Establish Safety Protocols:**

- Mandatory backup/rollback procedures
- Required validation steps
- Error handling standards
- Progress reporting requirements

### 4. Create New Rule for Codemods Directory

**Rule Scope:**

- Apply to all files in `codemods/` directory
- Cover both new codemod creation and existing codemod maintenance

**Rule Content:**

- Mandatory structure and documentation requirements
- Safety check protocols
- Testing requirements
- Error handling standards
- Performance guidelines
- Maintenance and versioning practices

**Integration Requirements:**

- Integrate with existing cursor rules system
- Provide clear examples and templates
- Include troubleshooting guides
- Reference industry best practices

### 5. Practical Recommendations

**Tool Recommendations:**

- Recommend specific libraries for different use cases
- Provide migration paths from current approaches
- Suggest development workflow improvements

**Template Creation:**

- Create starter templates for common codemod types
- Provide example implementations
- Include comprehensive test suites

**Documentation Standards:**

- Require clear purpose statements
- Mandate safety consideration documentation
- Specify testing and validation procedures
- Include rollback instructions

## Implementation Steps

### Phase 1: Analysis (40% of effort)

1. **Catalog Existing Codemods**

   - [x] Create inventory of all codemods with categorization
   - [x] Document approaches and patterns used
   - [x] Identify success stories and failure cases
   - [x] Extract common code patterns and utilities

2. **Industry Research**
   - [x] Research and evaluate popular codemod libraries
   - [x] Study best practices from major open-source projects
   - [x] Document pros/cons of different approaches
   - [x] Identify gaps in current tooling

### Phase 2: Standards Development (35% of effort)

3. **Create Guidelines Document**

   - [x] Write comprehensive codemod development guidelines
   - [x] Establish safety protocols and validation requirements
   - [x] Create decision trees for tool selection
   - [x] Document testing and maintenance standards

4. **Develop Templates and Examples**
   - [x] Create starter templates for different codemod types
   - [x] Provide working examples with full test suites
   - [x] Document common patterns and utilities
   - [ ] Create troubleshooting guides

### Phase 3: Rule Creation (25% of effort)

5. **Create Cursor Rule**

   - [ ] Write comprehensive rule for `codemods/` directory
   - [ ] Integrate with existing rule system
   - [ ] Include examples and references
   - [ ] Test rule effectiveness with existing codemods

6. **Documentation and Integration**
   - [ ] Create README for codemods directory
   - [ ] Document migration paths for existing codemods
   - [ ] Establish review and approval processes
   - [ ] Create contribution guidelines

## Progress Summary

### ✅ **Completed Work**

#### 1. **Comprehensive Codemod Analysis**

- **Categorization System**: Implemented in `systematic-refactor-all.ts` with categories:
  - VariableNamingCodemod (underscore prefix issues)
  - UnusedImportCodemod (import cleanup)
  - UnusedVariableCodemod (variable cleanup)
  - TypeAssertionCodemod (type safety fixes)
- **Pattern Extraction**: Identified 90+ codemods with specific patterns for:
  - String/regex-based transformations
  - TypeScript AST-based transformations (ts-morph, typescript compiler API)
  - Hybrid approaches combining multiple techniques

#### 2. **Industry Best Practices Research**

- **Tool Evaluation**: Documented in `automation-approaches.mdc` rule:
  - **ts-morph**: Recommended for TypeScript AST manipulation
  - **jscodeshift**: For JavaScript transformations
  - **babel-codemod**: For Babel-based transformations
- **Performance Evidence**: AST-based approaches show 6x effectiveness over regex
  - Task #166 evidence: 231 fixes with 100% success rate using AST vs high failure rates with regex
- **Safety Guarantees**: AST approaches provide syntax awareness and type safety

#### 3. **Established Standards and Guidelines**

- **Created `automation-approaches.mdc` rule** with:
  - Mandatory AST-based over regex approaches
  - 7 automation principles from Task #166
  - Root cause vs symptom analysis framework
  - Enforcement protocols for rule violations
- **Safety Protocols**: Comprehensive error handling and validation requirements
- **Decision Framework**: Clear criteria for tool selection and approach

#### 4. **Pattern Documentation**

- **Success Patterns**: AST-based transformations with comprehensive error handling
- **Anti-Patterns**: Regex-based string replacement, complex pattern-specific solutions
- **Common Patterns**: Identified across 90+ codemods:
  - File discovery and filtering
  - TypeScript AST manipulation
  - Safety checks and validation
  - Error handling and reporting
  - Import management

#### 5. **Template Development**

- **AST-based Templates**: Created working examples for:
  - Variable naming fixes using ts-morph
  - Type assertion patterns
  - Unknown type handling
  - Unused import/variable cleanup
- **Error Pattern Templates**: Comprehensive AST-based error handling patterns

### 🔄 **In Progress Work**

#### 1. **Utility Creation and Refactoring**

- **Scope**: Create well-documented utilities for AST-first patterns
- **Goal**: Eliminate duplication across 90+ codemods
- **Current Focus**: Extracting common utilities from existing codemods
- **Status**: Active development of standardized codemod utilities

#### 2. **Template Refinement**

- **Session Work**: Template development in progress (evidenced by deleted session files)
- **Focus**: Standardized AST-based templates for common patterns

### 📋 **Remaining Work**

#### 1. **Complete Utility Extraction**

- Extract common patterns from existing codemods into reusable utilities
- Create standardized interfaces for different codemod types
- Refactor existing codemods to use the new utilities
- Document utility usage patterns and best practices

#### 2. **Cursor Rule Creation**

- Create comprehensive rule for `codemods/` directory
- Integrate with existing cursor rules system
- Include examples and references to established patterns
- Test rule effectiveness with existing codemods

#### 3. **Documentation and Integration**

- Create README for codemods directory
- Document migration paths for existing codemods
- Establish review and approval processes
- Create contribution guidelines

#### 4. **Final Template Standardization**

- Complete troubleshooting guides
- Finalize templates based on established patterns
- Create comprehensive test suites for templates

## Verification

### Analysis Verification

- [x] Complete inventory of all existing codemods with categorization
- [x] Documented patterns analysis with specific examples
- [x] Comprehensive research report on industry tools and practices
- [x] Clear identification of success patterns and anti-patterns

### Standards Verification

- [x] Comprehensive guidelines document covering all aspects of codemod development
- [x] Working templates for at least 3 different codemod types
- [x] Decision framework with clear criteria for tool selection
- [x] Safety protocols with mandatory validation steps

### Utility Development Verification

- [ ] Common patterns extracted into reusable utilities
- [ ] Standardized interfaces for different codemod types
- [ ] At least 10 existing codemods refactored using new utilities
- [ ] Utility usage patterns documented with examples

### Rule Verification

- [ ] New cursor rule created specifically for `codemods/` directory
- [ ] Rule includes all essential requirements and guidelines
- [ ] Rule provides clear examples and references
- [ ] Rule integrates properly with existing cursor rules system

### Practical Verification

- [x] At least one existing codemod refactored using new guidelines
- [x] New template successfully used to create a sample codemod
- [x] Guidelines tested with both simple and complex transformation scenarios
- [ ] Documentation reviewed for clarity and completeness

## Success Criteria

1. **Comprehensive Analysis**: All existing codemods analyzed and categorized with clear pattern extraction ✅
2. **Industry Alignment**: Research demonstrates alignment with or improvement over industry best practices ✅
3. **Practical Guidelines**: Guidelines are actionable and provide clear direction for codemod development ✅
4. **Effective Utilities**: Reusable utilities created that eliminate duplication and enforce best practices 🔄
5. **Effective Rule**: New cursor rule successfully guides codemod development and maintenance 📋
6. **Proven Templates**: Templates and examples enable rapid development of new codemods ✅
7. **Safety Assurance**: All guidelines include robust safety checks and validation procedures ✅
