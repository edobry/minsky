# Test Plan: md#427 - Conventional Commit Validation on session pr edit

- Unit tests for edit command title/type handling
- Integration-like tests to ensure validation triggers before backend operations
- Negative cases:
  - --title with no --type and not conventional → error
  - --title already prefixed with --type present → error
- Positive cases:
  - --type + description-only title → success path
  - Full conventional title without --type → success path
