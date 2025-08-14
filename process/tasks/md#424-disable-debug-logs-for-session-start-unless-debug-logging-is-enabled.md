# Disable [DEBUG] logs for session start unless debug logging is enabled

## Context

Ensure that `[DEBUG]` log lines emitted during `minsky session start` are hidden by default and only appear when debug logging is explicitly enabled (e.g., via `--debug` or env var). Audit current logging calls in session start path and gate them behind the debug logger. Update tests accordingly.

## Requirements

## Solution

## Notes
