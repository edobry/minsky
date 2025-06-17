# Upgrade ESLint from v8.57.1 to v9.29.0

## Context

Handle the Dependabot PR #29 to upgrade ESLint from version 8.57.1 to 9.29.0. This is a major version upgrade that includes significant changes and new features that may require configuration updates and compatibility testing.

**Related PR**: [#29](https://github.com/edobry/minsky/pull/29)

## Problem Statement

ESLint v9 introduces breaking changes from v8, including:

- Changes to configuration format and structure
- Updates to rule behavior and options
- New TypeScript syntax support
- Performance improvements and new features

The current ESLint configuration needs to be updated to be compatible with v9 to avoid breaking the development workflow.

## Requirements

### Core Requirements

1. **Review Migration Guide**: Review the ESLint v9 migration guide and breaking changes documentation
2. **Update Configuration**: Update `.eslintrc.json` to be compatible with ESLint v9
3. **Plugin Compatibility**: Verify and update any ESLint plugins for v9 compatibility
4. **Fix Linting Issues**: Resolve any new linting errors that arise from the upgrade
5. **Test Configuration**: Verify the upgraded configuration works across the codebase
6. **Merge PR**: Merge Dependabot PR #29 after successful verification

### Technical Details

- **Current Version**: ESLint 8.57.1
- **Target Version**: ESLint 9.29.0
- **Configuration File**: `.eslintrc.json`
- **Test Command**: `npm run lint` or equivalent

### New Features in v9.29.0

- ECMAScript 2026 support with `using` and `await using` syntax
- Enhanced TypeScript syntax support in rules like `no-use-before-define`, `no-shadow`, `no-magic-numbers`
- Auto-accessor fields support in `class-methods-use-this`
- ES2025 globals support
- Performance improvements in `getLocFromIndex`

## Acceptance Criteria

- [ ] ESLint configuration is updated for v9 compatibility
- [ ] All existing ESLint rules continue to work as expected
- [ ] No new linting errors are introduced by the upgrade
- [ ] The linting process runs successfully on the entire codebase
- [ ] Any plugin compatibility issues are resolved
- [ ] Dependabot PR #29 is successfully merged
- [ ] Documentation is updated if configuration changes affect developer workflow

## Implementation Notes

1. **Configuration Migration**: ESLint v9 may require updates to configuration format
2. **Rule Changes**: Some rules may have new options or changed behavior
3. **Plugin Updates**: Third-party plugins may need updates for v9 compatibility
4. **Testing Strategy**: Run linting on the entire codebase before merging

## Risk Assessment

- **Medium Risk**: Major version upgrade with potential breaking changes
- **Mitigation**: Thorough testing and configuration review before merging
- **Rollback Plan**: Revert to v8.57.1 if critical issues arise

## Dependencies

- Dependabot PR #29 must remain open until work is complete
- Any ESLint plugins used in the project may need updates
