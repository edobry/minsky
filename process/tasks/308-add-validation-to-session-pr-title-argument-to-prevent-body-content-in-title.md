# Add validation to session PR title argument to prevent body content in title

## Context

## Problem

Currently the `minsky session pr --title` argument accepts arbitrarily long content, allowing users to accidentally put entire PR descriptions in the title field instead of using `--body` or `--body-path`.

This happened in Task #294 where a long description was passed to `--title` instead of being properly structured with a concise title and separate body.

## Requirements

### Title Validation
1. **Maximum length limit**: Enforce reasonable title length (e.g., 80-100 characters)
2. **No newlines**: Reject titles containing newline characters  
3. **No markdown**: Detect and reject markdown formatting in titles
4. **Clear error messages**: Provide helpful guidance when validation fails

### Body Requirement Enforcement
1. **Require body for meaningful PRs**: Enforce that `--body` or `--body-path` is provided
2. **Detect when title looks like body content**: Identify common patterns that suggest content belongs in body
3. **Helpful suggestions**: Guide users to use proper `--body-path` workflow

### Validation Rules

```typescript
interface TitleValidation {
  maxLength: 80;
  patterns: {
    noNewlines: true;
    noMarkdown: true; // ## headers, - bullets, etc.
    noMultiSentences: true; // Multiple periods/questions
  };
}
```

### Error Messages
- "Title too long ({{length}}/80 characters). Use --body or --body-path for detailed descriptions."
- "Title contains newlines. Use --body for multi-line descriptions."  
- "Title appears to contain body content. Use --body-path for detailed PR descriptions."
- "PR body is required. Use --body 'description' or --body-path path/to/pr.md"

## Implementation

### CLI Validation
1. Add title validation to session PR command
2. Enhanced error messages with examples
3. Early validation before PR creation process

### Integration  
1. Update session PR workflow documentation
2. Add validation to prevent common mistakes
3. Ensure validation works with existing PR creation flow

## Success Criteria

- ✅ Impossible to create PR with body content in title
- ✅ Clear, helpful error messages guide correct usage
- ✅ Title length enforced to reasonable limits
- ✅ Body requirement properly enforced
- ✅ Existing valid usage patterns continue to work

## Examples

### Valid Usage ✅
```bash
minsky session pr --title "fix(#294): Add concurrency fixes" --body-path process/tasks/294/pr.md
```

### Invalid Usage ❌ (Should be rejected)
```bash
minsky session pr --title "fix(#294): Complete audit with 17+ fixes and comprehensive ESLint rules for prevention"
```

This validation will prevent the accidental misuse experienced in Task #294 and ensure proper PR formatting.

## Requirements

## Solution

## Notes
