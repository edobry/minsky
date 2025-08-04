# Create ESLint rule to prevent direct environment variable access outside configuration system

## Context

Create a custom ESLint rule that prevents direct access to `process.env` anywhere in the codebase except:

1. **Configuration system code** - Files within `src/domain/configuration/` 
2. **Tooling code** - ESLint configs, helper scripts, build scripts, etc.
3. **Test files** - Where direct env access might be needed for test setup

## Problem

We just discovered bugs where code was accessing `process.env.GITHUB_TOKEN` directly instead of using the configuration system (`getConfiguration().github.token`). This led to:

- GitHub tokens configured in `~/.config/minsky/config.yaml` not being detected
- Inconsistency between different parts of the system
- Maintenance burden of updating multiple places when credential access patterns change

## Solution

Create an ESLint rule that:

### Disallows
- `process.env.GITHUB_TOKEN` outside configuration system
- `process.env.GH_TOKEN` outside configuration system  
- `process.env.OPENAI_API_KEY` outside configuration system
- Any direct `process.env.*` access in application code

### Allows
- `process.env` access in configuration system files (`src/domain/configuration/**`)
- `process.env` access in tooling files (`.eslintrc.js`, build scripts, etc.)
- `process.env.NODE_ENV` (standard Node.js environment check)
- `process.env` access in test files for test setup
- Specific allowlist for legitimate use cases

### Rule Configuration
- Should be configurable to add/remove allowed patterns
- Should provide helpful error messages suggesting the correct configuration system approach
- Should have auto-fix capability where possible (suggest `getConfiguration().github.token` instead of `process.env.GITHUB_TOKEN`)

## Files to Check
Based on our recent fix, scan the codebase for:
- Direct `process.env` usage that should use configuration system
- Update any remaining instances to use proper configuration access

## Implementation Details
- Custom ESLint rule in `.eslint/rules/` or similar
- Integration with existing ESLint configuration
- Documentation on when direct env var access is appropriate
- Examples of correct patterns in rule documentation

This will prevent future bugs like the GitHub token detection issue we just fixed and ensure consistent credential/configuration access patterns across the codebase.

## Requirements

## Solution

## Notes
