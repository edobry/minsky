# Task #140: Fix dependency installation error in session startup

## Problem

When starting a new session, the dependency installation fails with the error:

```
null is not an object (evaluating 'execSync(installCmd, {
      cwd: repoPath,
      stdio: options.quiet ? "ignore" : "inherit"
    }).toString')
```

This error occurs because when `execSync` is called with `stdio: "ignore"`, it returns `null` instead of a Buffer, but the code attempts to call `.toString()` on the null value.

## Root Cause

In `src/utils/package-manager.ts`, line 96, the code calls:

```typescript
const output = execSync(installCmd, {
  cwd: repoPath,
  stdio: options.quiet ? "ignore" : "inherit",
}).toString();
```

When `stdio: "ignore"` is used, `execSync` returns `null`, not a Buffer, so calling `.toString()` fails.

## Solution

Fix the code to handle the case where `execSync` returns `null` when using `stdio: "ignore"`.

## Requirements

1. Modify the `installDependencies` function in `src/utils/package-manager.ts` to handle null return values from `execSync`
2. When `options.quiet` is true and `stdio: "ignore"` is used, don't attempt to call `.toString()` on the result
3. Return appropriate success/failure status regardless of whether output is captured
4. Ensure existing functionality is preserved for non-quiet mode
5. Add proper error handling for the quiet mode case
6. Test that session startup works correctly after the fix

## Acceptance Criteria

- [ ] Session startup no longer fails with the null toString error
- [ ] Dependency installation works in both quiet and non-quiet modes
- [ ] Error handling is properly implemented for both execution modes
- [ ] Existing tests continue to pass
- [ ] Manual testing confirms session startup works correctly
