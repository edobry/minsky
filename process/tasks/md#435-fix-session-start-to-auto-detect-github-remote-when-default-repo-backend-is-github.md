# Fix session start to auto-detect GitHub remote when default_repo_backend is github

## Context

Auto-created task for session: Fix session start to auto-detect GitHub remote when default_repo_backend is github

## Requirements

1. When `repository.default_repo_backend` is `github` and `--repo` is not provided, auto-detect the GitHub remote from the current working directory.
2. Persist detected repository backend on the session record (`backendType`).
3. Keep adapter thin; business logic must live in the domain method.

## Solution

- Updated domain `startSessionImpl` to:
  - Read configuration via `getConfiguration()` and check `repository.default_repo_backend`.
  - If `github`, run `git remote get-url origin` to detect a GitHub remote; error with clear guidance if missing.
  - Fall back to DI `resolveRepoPath` and unified resolver when not set or not GitHub.
  - Detect and persist `backendType` via `detectRepositoryBackendTypeFromUrl(repoUrl)`.
- Kept CLI adapter thin; no backend detection logic there.

## Verification

- Added/updated tests to assert GitHub auto-detection path and `backendType` persistence.
- Targeted tests for `startSessionImpl - backendType` are green.

## Notes

- This aligns with the architecture rule: adapters delegate; domain owns business logic.
