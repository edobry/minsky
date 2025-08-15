## Summary

Enforce conventional-commit title validation on `session pr edit` to match `session pr create`.

## Changes

- Add optional `--type` to `session pr edit` for composing conventional titles from description-only `--title`
- Validate titles: if `--type` omitted, require a full conventional title; if provided, reject pre-prefixed titles and compose `type(scope): title`
- Reuse `assertValidPrTitle` hygiene checks (length, markdown, newlines)
- Tests for positive/negative cases

## Examples

- Valid:
  - `minsky session pr edit --type feat --title "add x"`
  - `minsky session pr edit --title "fix(ui): adjust y"`
- Invalid:
  - `minsky session pr edit --title "add x"`
