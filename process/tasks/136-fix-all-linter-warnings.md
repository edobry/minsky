# Task 136: Fix all ESLint warnings and errors across the codebase

## Current Status: IN-PROGRESS

### Current State
- **Total Issues**: 1,238 (4 errors, 1,234 warnings)
- **Primary Issue**: Unused variables (99% of warnings)
- **Session Progress**: Fixed 61 issues conservatively

### Critical Error History & Lessons Learned

#### Major Codemod Failure
- **What Happened**: Previous aggressive codemod incorrectly prefixed USED variables with underscores
- **User Feedback**: "why the hell are you prefixing USED VARIABLES with underscore????"
- **Root Cause**: Used regex patterns without semantic analysis
- **Recovery**: Applied conservative fixes to correct mismatches

#### Key Learnings
1. **Regex patterns cannot determine variable usage** - Need proper AST analysis
2. **Always verify changes** - Check if error count decreases after changes
3. **Conservative approach required** - Small, verifiable fixes only
4. **ESLint --fix is limited** - Doesn't fix unused variable issues

### Remaining Issues Analysis

#### Pattern 1: Genuine Bugs from Previous Errors
Example: `const _result = ...` but code uses `result` (without underscore)
- Found in test files primarily
- Requires careful manual fixing

#### Pattern 2: Actually Unused Variables
Variables correctly prefixed with underscore but never used
- Need to determine if intentionally unused or can be removed

#### Pattern 3: Missing Underscore Prefix
Variables that are unused but not prefixed (ESLint rule requires prefix)

### Next Steps - Conservative Approach

1. **Manual Analysis First**
   - Analyze specific files to understand patterns
   - Verify if variables are actually unused before changes
   - Use TypeScript compiler API for proper analysis

2. **Small Batch Fixes**
   - Fix 5-10 files at a time
   - Verify each batch reduces error count
   - Commit after each successful batch

3. **Focus on Clear Bugs First**
   - Fix `_result`/`result` mismatches
   - Remove clearly unused imports
   - Add underscore prefix to intentionally unused parameters

### Tools Available
- Session workspace with all dependencies
- Previous codemods (use with extreme caution)
- ESLint for verification
- Git for incremental commits

### Progress Tracking
- Initial: ~3,700 issues
- Previous best: 505 issues  
- Current: 1,238 issues
- Next target: <1,000 issues through conservative fixes

**Status**: Methodology requires fundamental improvement. Aggressive automation without semantic analysis caused regression.

## References

- **Session workspace**: `/Users/edobry/.local/state/minsky/git/local-minsky/sessions/136`
- **Baseline**: Approximately 3,700 initial issues across codebase
- **Previous best**: 505 issues achieved in earlier session
- **Current**: 1,238 issues after codemod errors

---

**Last Updated**: Current session  
**Next Review**: After conservative manual fixes show progress
