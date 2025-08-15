## md#427: Enforce conventional-commit title validation on session pr edit

- session pr edit now enforces conventional-commit title rules similar to session pr create
- Added optional --type for edit to compose titles from description-only --title
- Validation runs regardless of --no-status-update
- Added tests under tests/integration/session/pr-edit-validation.test.ts and src/adapters/shared/commands/session/pr-subcommand-commands.edit-validation.test.ts
