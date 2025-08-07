# Notes

- Spec confirms multiple competing parsing systems; standardize on `backend#id` per spec.
- Avoid reintroducing normalization that strips prefixes.
- Ensure CLI schemas accept both qualified and legacy inputs.
- Use testing-session-repo-changes: run via `bun run ./src/cli.ts ...` inside session.
