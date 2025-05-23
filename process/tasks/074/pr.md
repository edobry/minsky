# fix(#074): Fix Bun package manager detection in auto-dependency installation

## Summary

Fixed critical bugs in the auto-dependency installation feature for task #074 that was preventing Bun from being properly detected during session creation. The feature was implemented but broken due to incorrect file detection, causing Bun projects to incorrectly fall back to npm installation.

## Motivation & Context

Task #074 implemented auto-dependency installation to eliminate the manual step of running `bun install` (or equivalent) after creating a new session workspace. However, user reports indicated that the feature wasn't working correctly - specifically, Bun projects were failing with "env: node: No such file or directory" errors during session creation.

Investigation revealed that while the auto-dependency installation feature was fully implemented with comprehensive tests, it contained critical bugs that prevented proper operation. The feature is essential for developer workflow efficiency, especially for first-time session users who would otherwise encounter confusing module resolution errors.

## Design/Approach

The fix involved correcting the package manager detection logic while maintaining the existing architecture:

1. **Root Cause Analysis**: Identified that the package manager detection was checking for the wrong Bun lock file name
2. **Minimal Impact Fix**: Corrected the file detection without changing the overall architecture
3. **CLI Enhancement**: Added the missing `--packageManager` flag that was implemented in the domain layer but not exposed via CLI
4. **Backward Compatibility**: Ensured all changes maintain existing behavior for working package managers

Alternative approaches considered:

- **Complete Rewrite**: Rejected as the existing implementation was sound, just had incorrect file names
- **Configuration-Based Detection**: Rejected as file-based detection is more reliable and follows standard practices

## Key Changes

### Package Manager Detection Fix

- Updated `src/utils/package-manager.ts` to check for `bun.lock` instead of `bun.lockb`
- This aligns with Bun's actual lock file naming convention
- Maintains priority order: bun.lock → yarn.lock → pnpm-lock.yaml → package-lock.json → package.json

### CLI Interface Enhancement

- Added `--packageManager` parameter to session start command in `src/adapters/shared/commands/session.ts`
- Enabled users to override auto-detection with explicit package manager choice
- Parameter accepts: `bun`, `npm`, `yarn`, `pnpm`
- Properly wired parameter through shared command registry to domain layer

### Test Updates

- Updated test case description for accuracy: "detects bun from bun.lock" instead of "detects bun from bun.lockb"
- All existing test logic remains valid as it was testing the correct behavior

## Testing

### Test Suite Verification

- All 17 package manager utility tests pass
- Tests verify correct detection logic for all supported package managers
- Tests validate proper error handling and edge cases

### Manual Testing

- Verified session creation now correctly detects Bun from `bun.lock` files
- Tested CLI parameter handling for new `--packageManager` flag
- Confirmed graceful error handling when installation fails

### Integration Testing

- Session creation workflow tested end-to-end
- Verified dependency installation occurs automatically during session setup
- Confirmed `--skipInstall` flag still works correctly

## Verification

### Before Fix

Session creation with Bun projects would fail:

<pre><code class="language-bash">
$ minsky session start 123
env: node: No such file or directory
Failed to install dependencies: Command failed: npm install
Warning: Dependency installation failed. You may need to run install manually.
</code></pre>

### After Fix

Session creation correctly detects and uses Bun:

<pre><code class="language-bash">
$ minsky session start 123
Installing dependencies using bun...
# Successfully runs bun install and creates session
success: true
</code></pre>

### New CLI Flag Usage

Users can now override package manager detection:

<pre><code class="language-bash">
$ minsky session start 123 --packageManager bun
$ minsky session start 123 --skipInstall
</code></pre>

## Root Cause Analysis

The auto-dependency installation feature was **already implemented** with comprehensive functionality including:

- ✅ Package manager detection utilities
- ✅ Installation command mapping
- ✅ Error handling with graceful degradation
- ✅ CLI flag support (`--skipInstall`)
- ✅ Integration with session creation workflow
- ✅ Complete test suite (17 tests)

However, it contained a critical bug where the Bun detection logic was checking for `bun.lockb` instead of `bun.lock`. This caused all Bun projects to fall back to npm installation, which would fail in environments where Node.js wasn't available, leading to confusing error messages.

## Base Branch: main

## PR Branch: pr/task#074
