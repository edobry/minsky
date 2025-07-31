## Summary

This PR completes the production readiness improvements for the GitHub Issues task backend while awaiting foundational repository backend integration work (Task 161 Phase 0).

## Changes

### Added

- **Comprehensive Documentation Package**
  - `docs/github-issues-backend-guide.md` - Complete setup and usage guide
  - Setup instructions for GitHub Personal Access Tokens
  - Repository configuration guidelines
  - Troubleshooting and best practices

- **GitHub CLI Command Suite**
  - `minsky github test` - Test GitHub API connectivity and authentication
  - `minsky github status` - Show GitHub backend configuration status
  - Enhanced diagnostic capabilities with `--verbose` option

- **Integration Test Suite** (separate from main test suite)
  - `tests/integration/github-api.integration.test.ts` - GitHub API connectivity tests
  - `tests/integration/github-issues-backend.integration.test.ts` - Backend functionality tests
  - Tests run explicitly only, not as part of default test suite
  - Comprehensive real GitHub API testing with cleanup

### Fixed

- **Authentication Environment Variable Bug**: Fixed `GITHUBTOKEN` → `GITHUB_TOKEN`
- **Dynamic Imports Rule Violation**: Replaced dynamic imports with static imports in `TaskService`
- **Configuration Validation Issues**: Proper Zod schema alignment
- **Linting and Formatting**: Resolved Prettier/ESLint issues across all new files

### Enhanced

- **Architectural Clarity**: GitHub Issues task backend now explicitly requires GitHub repository backend
- **Error Handling**: Clear error messages when repository backend requirements not met
- **Configuration System**: Proper integration with hierarchical configuration

## Architectural Foundation

This PR establishes the production readiness of the GitHub Issues backend while maintaining compatibility with the planned repository backend architecture (Task 161 Phase 0). The backend now:

- Explicitly validates repository backend compatibility
- Provides clear error messages for architectural mismatches
- Includes comprehensive diagnostic tools
- Maintains session-first workflow compliance

## Testing

- ✅ All existing tests pass
- ✅ New integration tests validate real GitHub API operations
- ✅ CLI commands tested with various configuration scenarios
- ✅ Documentation verified with step-by-step setup

## Dependencies

Remaining work depends on:
- **Task 161 Phase 0**: Repository backend auto-detection and integration
- **Task 357**: Integration of GitHub Issues backend with repository backend architecture

## Integration Status

The GitHub Issues backend is now production-ready for teams with:
- GitHub Personal Access Tokens configured
- GitHub repository backends (when Task 161 Phase 0 is complete)
- Proper session workspace workflow

The backend gracefully errors when repository backend requirements are not met, ensuring clear user guidance toward proper configuration. 
