# Enable max-lines ESLint rule with two-phase approach (400 warning, 1500 error)

## Context

Currently, the `max-lines` ESLint rule is explicitly disabled in `eslint.config.js`:

```javascript
"max-lines": "off",
```

However, the codebase has identified file size as a concern, with 36 files exceeding 400 lines including some massive files (e.g., `src/domain/git.ts` at 2,476 lines). The project uses Cursor rules for soft guidance (~400 lines), but lacks automated enforcement.

This task implements a two-phase ESLint approach:

- **Phase 1**: Warning at 400 lines for early intervention
- **Phase 2**: Error at 1500 lines to prevent extremely large files

## Problem Statement

**Current Issues:**

- No automated file size enforcement
- Large files create maintenance difficulties
- Cursor rules provide guidance but no CI/CD integration
- Some files are extremely large (1000+ lines)

**Desired State:**

- Gentle warnings at reasonable thresholds (400 lines)
- Hard stops for extremely large files (1500 lines)
- Skip blank lines and comments for more accurate measurements
- Maintain existing codebase without immediate breaking changes

## Requirements

### Phase 1: Basic max-lines Rule (400 lines warning)

1. **Enable max-lines as warning**:

   ```javascript
   "max-lines": ["warn", {
     "max": 400,
     "skipBlankLines": true,
     "skipComments": true
   }]
   ```

2. **Configuration requirements**:
   - Maximum 400 lines (matches Cursor rule guidance)
   - Skip blank lines: `true` (focus on actual code)
   - Skip comments: `true` (focus on logic, not documentation)
   - Severity: `"warn"` (non-blocking for existing large files)

### Phase 2: Research Two-Phase Configuration

1. **Investigate ESLint multi-configuration approaches**:

   - Can ESLint support two different max-lines thresholds?
   - Custom rule creation for two-phase file size checking
   - Alternative approaches (plugins, custom rules, multiple configs)

2. **Implement 1500-line error threshold**:

   - Research feasibility of dual thresholds
   - Implement solution that errors at 1500 lines
   - Ensure compatibility with 400-line warning

3. **Configuration validation**:
   - Test that both thresholds work correctly
   - Verify skipBlankLines and skipComments apply to both
   - Ensure proper error messages and line counting

### Phase 3: Integration and Testing

1. **Codebase impact analysis**:

   - Run ESLint with new configuration
   - Document all files that trigger warnings/errors
   - Verify no immediate CI/CD breakage

2. **Developer experience**:
   - Clear error messages for both thresholds
   - Documentation updates for new linting rules
   - Integration with existing lint scripts

## Implementation Steps

### Step 1: Enable Basic max-lines Rule

- [ ] Update `eslint.config.js` to enable max-lines as warning
- [ ] Configure with 400 line limit, skipBlankLines: true, skipComments: true
- [ ] Test configuration with `bun run lint`
- [ ] Document initial warning count and affected files

### Step 2: Research Two-Phase Approach

- [ ] Research ESLint capabilities for multiple max-lines thresholds
- [ ] Investigate these approaches:
  - [ ] Multiple ESLint configurations with different file patterns
  - [ ] Custom ESLint rule for two-phase file size checking
  - [ ] ESLint plugin ecosystem for advanced file size rules
  - [ ] Overrides configuration for different severity levels

### Step 3: Implement Two-Phase Solution

- [ ] Choose best approach based on research
- [ ] Implement 1500-line error threshold alongside 400-line warning
- [ ] Create comprehensive tests for both thresholds
- [ ] Validate line counting accuracy (blank lines, comments)

### Step 4: Integration and Documentation

- [ ] Update documentation with new linting rules
- [ ] Add configuration comments explaining the two-phase approach
- [ ] Test integration with existing development workflow
- [ ] Create guidelines for developers on file size management

### Step 5: Validation and Rollout

- [ ] Run full lint suite and document results
- [ ] Verify CI/CD compatibility
- [ ] Create migration plan for existing large files if needed
- [ ] Update relevant Cursor rules or project documentation

## Technical Research Areas

### Multi-Configuration Approaches

1. **ESLint Overrides Pattern**:

   ```javascript
   export default [
     {
       rules: {
         "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
       },
     },
     {
       files: ["**/*.ts", "**/*.js"],
       rules: {
         "max-lines": ["error", { max: 1500, skipBlankLines: true, skipComments: true }],
       },
     },
   ];
   ```

2. **Custom Rule Development**:

   - Create `src/eslint-rules/max-lines-two-phase.js`
   - Implement dual threshold logic
   - Support configurable warning/error levels

3. **Plugin-Based Solutions**:
   - Research existing ESLint plugins for advanced file size rules
   - Evaluate `eslint-plugin-file-extension` or similar

### Line Counting Validation

- [ ] Test blank line handling accuracy
- [ ] Test comment line handling (single-line, multi-line, JSDoc)
- [ ] Verify consistent counting across different file types

## Success Criteria

1. **Basic Configuration Working**:

   - ESLint warns at 400 lines with proper skip options
   - Existing development workflow unaffected
   - Clear, actionable warning messages

2. **Two-Phase Implementation**:

   - Dual thresholds working (400 warn, 1500 error)
   - Accurate line counting with skip options
   - No conflicts between warning and error rules

3. **Integration Success**:
   - CI/CD pipeline compatibility
   - Developer-friendly error messages
   - Documentation updated and accessible

## Expected Outcomes

- **Immediate**: 400-line warnings provide gentle guidance
- **Long-term**: 1500-line errors prevent extremely large files
- **Process**: Better file size awareness in development workflow
- **Quality**: Improved codebase maintainability and readability

## Notes

- **Alignment**: This task aligns with existing Cursor rule guidance (~400 lines)
- **Non-Breaking**: Initial implementation uses warnings to avoid disrupting existing workflow
