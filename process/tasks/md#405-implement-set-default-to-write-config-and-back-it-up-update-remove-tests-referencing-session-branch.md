# Implement --set-default to write config and back it up; update/remove tests referencing session.branch

## Context

Follow up to task md#404-add-configuration-management-subcommands.md. Implement behavior for `minsky sessiondb migrate --set-default` to actually update the user config file at ~/.config/minsky/config.yaml. Requirements:

- Create a timestamped backup before writing
- Update [sessiondb] backend and [sessiondb.postgres] connectionString (or sqlite path) according to target
- Validate config after write; on failure, restore from backup
- Emit concise human-friendly logs (no JSON)
- Add tests covering config write, backup/restore, validation failure path

Additionally, update or remove tests that reference the removed `branch` field from sessions, aligning with the schema change (branch dropped). Ensure all tests pass.

## Requirements

## Solution

## Notes
