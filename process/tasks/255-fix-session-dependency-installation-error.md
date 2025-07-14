# Fix session dependency installation error

## Status

COMPLETED

## Priority

MEDIUM

## Description

Investigate and fix the 'Failed to install dependencies' error that occurs during session startup where execSync returns null instead of expected object

## Requirements

1. ✅ Fix the `installDependencies` function in `src/utils/package-manager.ts` to handle null return values from `execSync`
2. ✅ Handle the case where `execSync` returns null when `stdio: "ignore"` is used
3. ✅ Ensure existing functionality is preserved for non-quiet mode
4. ✅ Verify the fix works with session startup

## Root Cause

The issue was in `src/utils/package-manager.ts` on line 96 where the code called:

```typescript
const output = (result as any).toString() || "";
```

When `execSync` is called with `stdio: "ignore"`, it returns `null` instead of a Buffer. Calling `.toString()` on `null` throws the error: "null is not an object".

## Solution

Fixed the code to properly handle the null case:

```typescript
const output = result ? (result as any).toString() : "";
```

This checks if `result` is truthy before calling `.toString()` on it.

## Success Criteria

- ✅ Session startup no longer fails with the null toString error
- ✅ Dependency installation works in both quiet and non-quiet modes
- ✅ All existing package manager tests pass
- ✅ Manual testing confirms session startup works correctly in quiet mode

## Testing

- All package manager tests pass (17/17)
- Manual testing with `minsky session start --description "test" --quiet` works without error
- Session creation completes successfully without the dependency installation error 
