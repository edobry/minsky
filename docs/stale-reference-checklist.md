# Stale Reference Regression Checklist

This file tracks terms that should return zero results in `docs/` after the mt#772 cleanup.

Run each grep below — it should return 0 hits. If any return results, investigate and update the relevant doc.

```bash
# Removed task backends (should not appear as backend names)
grep -rn "json-file" docs/
grep -rn "json-storage" docs/
grep -rn "markdown backend" docs/
grep -rn "markdown-file" docs/

# Removed class names
grep -rn "JsonFileTaskBackend" docs/
grep -rn "MarkdownTaskBackend" docs/
grep -rn "JsonStorageProvider" docs/

# Removed config examples
grep -rn 'tasks-backend markdown' docs/
grep -rn 'backend.*"md"' docs/
grep -rn '"json-file"' docs/

# Legacy sessiondb backend (removed; only sqlite and postgres are valid)
grep -rn 'sessiondb:' docs/ | grep '"json"'
```

## Known valid uses (do not flag)

- `markdown` as a file format (e.g., `.md` files, "markdown format") — NOT a backend name
- `json` as a data format or output flag (e.g., `--json`, JSON output) — NOT a backend name
- `--from json` in sessiondb migration — legacy path from old json sessiondb, documented as legacy
- References inside historical documents (marked with `> **Historical document**`) — leave as-is
- `md#` or `json#` inside historical/context notes explaining what was removed
