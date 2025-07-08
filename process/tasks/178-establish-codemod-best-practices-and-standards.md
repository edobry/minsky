# Task #178: Establish Codemod Best Practices and Standards

## Context

The Minsky project has accumulated 90+ codemods in the `codemods/` directory, representing significant experience in automated code transformation. Recent work has revealed critical insights about effective codemod development approaches.

**CRITICAL DISCOVERY FROM TASK #166**: AST-based approaches are **6x more effective** than regex-based approaches:
- AST-based fix-variable-naming-ast.ts: 231 fixes with 100% success rate, zero syntax errors
- Regex-based approaches: High syntax error rates, complex pattern matching, frequent failures

**KEY INSIGHT**: The most effective codemods address **root causes** rather than symptoms, using simple principles that handle multiple cases instead of complex pattern-specific solutions.

This task aims to:
1. Analyze existing codemods to extract proven patterns and anti-patterns
2. Establish AST-based approaches as the mandatory standard
3. Create comprehensive guidelines based on concrete evidence from recent work
4. Establish a standardized structure prioritizing safety and effectiveness

## Requirements

### 1. Codemod Analysis and Pattern Extraction

**Analyze Existing Codemods:**
- Review all 90+ codemods in the `codemods/` directory
- **Categorize codemods by effectiveness (based on Task #166 evidence):**
  - **HIGH EFFECTIVENESS**: AST-based transformations (ts-morph, typescript compiler API)
  - **MEDIUM EFFECTIVENESS**: ESLint output parsing and targeted fixes
  - **LOW EFFECTIVENESS**: Simple string/regex-based transformations (to be migrated)
  - **DEPRECATED**: Complex pattern-specific regex solutions
- **Identify effectiveness patterns:**
  - Root cause vs symptom treatment
  - Safety mechanisms and validation
  - Error handling and reporting
  - Performance and reliability metrics
  - Import management and AST manipulation

**Extract Success Patterns from Task #166:**
- Document AST-based transformation techniques
- Identify robust error handling approaches with try-catch
- Catalog successful ts-morph integration patterns
- Note effective before/after validation strategies
- **Root cause analysis methodology**

**Identify Anti-Patterns from Task #166:**
- **CRITICAL**: Complex pattern-specific regex solutions
- **Pattern accumulation**: Adding more regex patterns when issues remain
- **Context enumeration**: Trying to handle every usage context
- **Symptom chasing**: Fixing manifestations instead of causes
- Performance bottlenecks from regex complexity

### 2. Industry Best Practices Research

**Research Popular Codemod Libraries (Prioritized by Task #166 Evidence):**
- **PRIMARY (MANDATORY)**: **ts-morph** - TypeScript compiler API wrapper
- **APPROVED**: **jscodeshift** - Facebook's codemod toolkit for JavaScript
- **APPROVED**: **babel-codemod** - Babel-based transformations
- **RESEARCH**: **ast-grep** - Tree-sitter based code search and transformation
- **RESEARCH**: **recast** - JavaScript AST transformation toolkit
- **DEPRECATED**: **comby** - Language-agnostic structural search and replace

**Evaluate Library Benefits (Evidence-Based):**
- **Safety guarantees**: AST prevents syntax errors vs regex breaking code
- **Performance characteristics**: Task #166 shows 6x improvement with AST
- **Maintainability**: Clear AST logic vs complex regex patterns
- **Community adoption**: ts-morph integration with TypeScript ecosystem
- **Integration complexity**: Proven simplicity in recent implementations

**Study Best Practices (Based on Concrete Evidence):**
- Review Task #166 implementation patterns
- Analyze automation-approaches.mdc rule principles
- Document root cause analysis methodology
- Study error handling and rollback strategies

### 3. Create Comprehensive Guidelines

**Develop Codemod Standards (Evidence-Based):**
- **MANDATORY**: AST-based approaches using ts-morph or approved libraries
- **PROHIBITED**: Regex-based string replacement for complex transformations
- **REQUIRED**: Root cause analysis before implementation
- **REQUIRED**: Before/after error count validation
- **REQUIRED**: Comprehensive error handling with try-catch
- **REQUIRED**: Progress reporting and logging

**Create Decision Framework (Based on Task #166 Evidence):**
- **Default Choice**: AST-based transformations using ts-morph
- **Root Cause Analysis**: Identify fundamental issue vs symptoms
- **Simple Algorithm Priority**: One principle handling multiple cases
- **Complexity Justification**: Complex patterns only when multiple distinct root causes exist
- **Performance Validation**: Measure effectiveness (fixes per run, success rate)

**Establish Safety Protocols (Task #166 Proven):**
- **Mandatory**: TypeScript compilation before and after
- **Mandatory**: Syntax validation through AST
- **Mandatory**: Comprehensive error handling
- **Mandatory**: Progress reporting with concrete metrics
- **Mandatory**: Zero syntax errors introduced

### 4. Create New Rule for Codemods Directory

**Rule Scope:**
- Apply to all files in `codemods/` directory
- **Enforce AST-based approaches**
- **Prohibit complex regex patterns**
- Cover both new codemod creation and existing codemod maintenance

**Rule Content (Based on automation-approaches.mdc):**
- **CRITICAL**: AST-based over regex (6x more effective)
- **CRITICAL**: Root cause vs symptom treatment
- **CRITICAL**: Simple algorithms over complex patterns
- Mandatory structure and documentation requirements
- Safety check protocols from Task #166
- Testing requirements with before/after validation
- Error handling standards with try-catch
- Performance guidelines with concrete metrics

**Integration Requirements:**
- Integrate with existing cursor rules system
- Reference automation-approaches.mdc rule
- Include Task #166 examples and evidence
- Include troubleshooting guides for AST development

### 5. Practical Recommendations

**Tool Recommendations (Evidence-Based):**
- **PRIMARY**: ts-morph for TypeScript AST manipulation
- **APPROVED**: jscodeshift for JavaScript transformations
- **APPROVED**: babel-codemod for Babel-based transformations
- **MIGRATION PATH**: Convert existing regex codemods to AST-based
- **DEVELOPMENT WORKFLOW**: Root cause analysis → AST implementation → validation

**Template Creation (Based on Task #166 Success):**
- **AST-based codemod template** using ts-morph
- **Root cause analysis template**
- **Error handling template** with try-catch
- **Before/after validation template**
- **Progress reporting template**

**Documentation Standards (Task #166 Evidence):**
- **REQUIRED**: Root cause analysis documentation
- **REQUIRED**: AST approach justification
- **REQUIRED**: Safety consideration documentation
- **REQUIRED**: Before/after error count metrics
- **REQUIRED**: Performance and reliability metrics

## Implementation Steps

### Phase 1: Analysis (40% of effort)
1. **Catalog Existing Codemods with Effectiveness Rating**
   - [ ] Create inventory categorized by AST vs regex approach
   - [ ] Document effectiveness patterns from Task #166 evidence
   - [ ] Identify regex codemods for migration to AST
   - [ ] Extract root cause analysis examples

2. **Evidence-Based Research**
   - [ ] Document Task #166 AST transformation patterns
   - [ ] Study automation-approaches.mdc rule principles
   - [ ] Research ts-morph best practices and patterns
   - [ ] Document performance metrics and safety evidence

### Phase 2: Standards Development (35% of effort)
3. **Create Evidence-Based Guidelines Document**
   - [ ] Write AST-first codemod development guidelines
   - [ ] Establish root cause analysis protocols
   - [ ] Create decision trees prioritizing AST approaches
   - [ ] Document testing and validation standards from Task #166

4. **Develop AST-Based Templates and Examples**
   - [ ] Create ts-morph starter templates
   - [ ] Provide working examples with full test suites
   - [ ] Document common AST patterns and utilities
   - [ ] Create troubleshooting guides for AST development

### Phase 3: Rule Creation (25% of effort)
5. **Create Evidence-Based Cursor Rule**
   - [ ] Write comprehensive rule for `codemods/` directory
   - [ ] Integrate with automation-approaches.mdc rule
   - [ ] Include Task #166 examples and evidence
   - [ ] Test rule effectiveness with existing codemods

6. **Documentation and Migration Planning**
   - [ ] Create README for codemods directory
   - [ ] Document migration paths from regex to AST
   - [ ] Establish review and approval processes
   - [ ] Create contribution guidelines emphasizing AST approaches

## Verification

### Analysis Verification
- [ ] Complete inventory of all existing codemods with effectiveness categorization
- [ ] Documented patterns analysis with Task #166 examples
- [ ] Comprehensive research report on AST-based tools and practices
- [ ] Clear identification of success patterns and anti-patterns with evidence

### Standards Verification
- [ ] Comprehensive guidelines document covering AST-based development
- [ ] Working AST-based templates for at least 3 different codemod types
- [ ] Decision framework with clear criteria prioritizing AST approaches
- [ ] Safety protocols with mandatory validation steps from Task #166

### Rule Verification
- [ ] New cursor rule created specifically for `codemods/` directory
- [ ] Rule includes AST-based requirements and prohibits complex regex
- [ ] Rule provides clear examples and references Task #166 evidence
- [ ] Rule integrates properly with automation-approaches.mdc rule

### Practical Verification
- [ ] At least one existing regex codemod refactored to AST-based approach
- [ ] New AST-based template successfully used to create a sample codemod
- [ ] Guidelines tested with both simple and complex transformation scenarios
- [ ] Documentation reviewed for clarity and completeness

## Success Criteria

1. **Evidence-Based Analysis**: All existing codemods analyzed with effectiveness ratings based on Task #166 evidence
2. **AST-First Standards**: Guidelines prioritize AST-based approaches with 6x effectiveness evidence
3. **Practical Guidelines**: Guidelines are actionable and provide clear direction for AST-based development
4. **Effective Rule**: New cursor rule successfully enforces AST-based approaches and prohibits complex regex
5. **Proven Templates**: AST-based templates enable rapid development of new codemods
6. **Safety Assurance**: All guidelines include robust safety checks and validation procedures from Task #166

## Notes

**Key Insights from Task #166:**
- **AST-based approach provided 6x better results**: 231 fixes with 100% success rate
- **Root cause analysis crucial**: Simple algorithms more effective than complex patterns
- **ts-morph integration superior**: Zero syntax errors, built-in validation
- **Comprehensive error handling essential**: Try-catch prevents failures
- **Progress reporting crucial**: Before/after metrics validate effectiveness

**Critical Success Factors:**
- **AST-based approaches mandatory** for complex transformations
- **Root cause analysis required** before implementation
- **Performance metrics essential** for validation
- **Safety protocols non-negotiable** (zero syntax errors)
- **Simple algorithms preferred** over complex pattern-matching

**Evidence-Based Approach:**
This task specification has been updated to reflect concrete evidence from Task #166 and the automation-approaches.mdc rule, prioritizing proven effective approaches over theoretical possibilities.
