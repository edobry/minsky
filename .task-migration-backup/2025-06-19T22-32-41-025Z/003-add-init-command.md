# Task #003: Add `init` command to set up a project for Minsky

## Objective

Add a new CLI command `init` to the Minsky CLI that sets up a project to work with Minsky. The command should prompt for or accept parameters for the tasks backend and rule format, then perform initialization logic to create the appropriate files and directories in the target repository.

## UX and CLI Conventions

- The command must accept `--repo <path>` and `--session <name>` flags to locate the target repo, following the same pattern as other Minsky commands.
- Use the `resolveRepoPath` helper to determine the repo path:
  1. If `--repo` is provided, use it.
  2. If `--session` is provided, look up the repo path from the session DB.
  3. If neither is provided, default to the current git repo root (using `git rev-parse --show-toplevel`).
  4. If not in a git repo and no path is provided, error out.
- Use [`@clack/prompts`](https://www.npmjs.com/package/@clack/prompts) for interactive prompts:
  - Only prompt for values not provided via CLI flags.
  - Use selection prompts for backend and rule format.
  - If neither `--repo` nor `--session` is provided, prompt the user to confirm using the current directory's git root.
- If the user selects an unimplemented backend (e.g., `tasks.csv`), print a clear error and exit.
- When creating files or directories, create parent directories as needed, but do not overwrite existing files—error if the target file exists.

## Task Breakdown

- [ ] Add a new CLI command `init` to the Minsky CLI.
- [ ] Command should accept parameters for:
  - [ ] Tasks backend: `tasks.md` or `tasks.csv` (via CLI flag or interactive prompt)
  - [ ] Rule format: `cursor` or `generic` (via CLI flag or interactive prompt)
  - [ ] Target repo: via `--repo`, `--session`, or prompt (see above)
- [ ] After collecting parameters, run initialization logic:
  - [ ] For tasks backend, create an appropriately structured `process/tasks` system in the target repo.
  - [ ] For rule format:
    - [ ] If `cursor`, write the `minsky.mdc` rule to `.cursor/rules` in the target repo.
    - [ ] If `generic`, write the `minsky.mdc` rule to `.ai/rules` in the target repo (create directories if needed).
- [ ] If the user selects an unimplemented backend (e.g., `tasks.csv`), print a clear error and exit.
- [ ] Do not overwrite existing files; error if the target file exists.
- [ ] Follow all project conventions for command and domain module organization.
- [ ] Add/modify tests to cover the new command and its options (domain-level, not CLI-level):
  - [ ] Directory and file creation logic
  - [ ] Error if file/dir already exists
  - [ ] Error if unimplemented backend is selected
  - [ ] Correct file content for each rule format
  - [ ] Directory creation if missing
  - [ ] No overwrite of existing files
- [ ] Update the changelog with a reference to this SpecStory conversation.

## Verification

- The `minsky init` command appears in the CLI help.
- Running `minsky init` interactively prompts for or accepts flags for all parameters, using @clack/prompts for missing values.
- The correct files and directories are created in the target repo based on user choices.
- The `minsky.mdc` rule is written to the correct location.
- The command errors if the user selects an unimplemented backend or if a target file already exists.
- Tests for the new command pass (domain-level, not CLI-level).
- Changelog is updated with a reference to this conversation.

## Context/References

- See this SpecStory conversation for requirements and rationale.
