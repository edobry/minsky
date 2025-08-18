## Summary

Add Drizzle Kit PostgreSQL migrations for SessionDB and wire runtime migrator. Improve PR creation error messaging to surface actual GitHub API validation errors (e.g., no commits between base and head).

## Changes

- Add `drizzle.pg.config.ts`
- Generate PG migrations under `src/domain/storage/migrations/pg`
- Update `PostgresStorage.initialize()` to run migrations (no manual DDL)
- Docs: `docs/testing/postgres-migrations.md`
- Improve GitHub PR error handling to show 422 Validation details (no-changes, existing PR) instead of generic 403
- Update CHANGELOG

## Testing

- Run `minsky session pr create` from a session workspace with and without changes; verify messages:
  - 📝 No Changes to Create PR (422 no commits between)
  - 🔄 Pull Request Already Exists (422 existing PR)
  - 🚫 GitHub Permission Denied (actual 403)

## Checklist

- [x] All requirements implemented
- [x] Code quality acceptable
- [x] Documentation and changelog updated
