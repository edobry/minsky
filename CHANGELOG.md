# Changelog

## fix(md#414): strict task IDs, logger auto mode, PR prep test integrations

- Enforce strict-in/strict-out task IDs across schemas and resolvers
- Logger: auto mode now selects STRUCTURED when no TTY
- Session PR: adapted prepare-pr operations to use injected exec for tests, added legacy session name handling while preserving strict task ID policy
- ConflictDetectionService: short-circuit for mock paths in tests to prevent real git calls
- ConfigWriter and session update tests: preserved behavior; resolved prior strict ID regressions

