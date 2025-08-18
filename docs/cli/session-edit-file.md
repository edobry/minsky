# Session Edit File CLI Command

The `minsky session edit-file` command provides a user-friendly CLI wrapper around the `session.edit_file` MCP tool, enabling easy file editing within session workspaces using AI-powered pattern application.

## Overview

This command allows you to edit files in a session workspace by providing edit instructions and patterns. It supports both dry-run mode for previewing changes and direct file modification.

## Usage

```bash
minsky session edit-file --path <file-path> --instruction "<description>" [options]
```

## Parameters

### Required Parameters

- `--path <path>`: Path to the file within the session workspace
- `--instruction <text>`: Instructions describing the edit to make

### Optional Parameters

- `--session <name>` or `-s <name>`: Session name (auto-detected from workspace if not provided)
- `--pattern-file <path>` or `-f <path>`: Path to file containing edit pattern
- `--dry-run` or `-n`: Preview changes without writing to disk
- `--create-dirs`: Create parent directories if they don't exist (default: true)
- `--json`: Output in JSON format
- `--debug`: Enable debug output

## Input Methods

### 1. Reading Pattern from Stdin

You can pipe edit patterns directly to the command:

```bash
echo '// ... existing code ...
console.log("Hello, world!");
// ... existing code ...' | \
minsky session edit-file --path src/app.ts --instruction "Add hello world log"
```

### 2. Reading Pattern from File

Create a pattern file and reference it:

```bash
# Create pattern file
cat > pattern.txt << 'EOF'
// ... existing code ...
export function newFeature() {
  return "implemented";
}
// ... existing code ...
EOF

# Apply the pattern
minsky session edit-file --path src/features.ts --instruction "Add new feature" --pattern-file pattern.txt
```

## Examples

### Example 1: Basic File Edit

```bash
# Edit a file with pattern from stdin
echo '// ... existing code ...
function greet(name: string) {
  return `Hello, ${name}!`;
}
// ... existing code ...' | \
minsky session edit-file \
  --path src/utils.ts \
  --instruction "Add greeting function"
```

### Example 2: Dry-Run Preview

```bash
# Preview changes without applying them
echo '// ... existing code ...
const VERSION = "2.0.0";
// ... existing code ...' | \
minsky session edit-file \
  --path package.json \
  --instruction "Update version" \
  --dry-run
```

Expected output:

```
🔍 Dry-run: Would edit package.json

📊 Changes summary:
  +1 lines added
  -1 lines removed
  Total: 25 lines

📝 Unified diff:
--- package.json
+++ package.json
@@ -2,7 +2,7 @@
   "name": "my-package",
-  "version": "1.0.0",
+  "version": "2.0.0",
   "description": "My package",

💡 To apply these changes, run the same command without --dry-run
```

### Example 3: Creating New File

```bash
# Create a new file
echo 'export interface User {
  id: string;
  name: string;
  email: string;
}' | \
minsky session edit-file \
  --path src/types/user.ts \
  --instruction "Define User interface"
```

## Output Formats

### Standard Output

For successful edits:

```
✅ Successfully edited src/app.ts
```

For new file creation:

```
✅ Successfully created src/new-file.ts
```

### Dry-Run Output

Dry-run mode provides detailed preview information:

```
🔍 Dry-run: Would edit src/app.ts

📊 Changes summary:
  +5 lines added
  -2 lines removed
  Total: 120 lines

📝 Unified diff:
[unified diff content]

💡 To apply these changes, run the same command without --dry-run
```

## Best Practices

1. **Use Dry-Run First**: Always preview changes with `--dry-run` before applying them, especially for complex edits.

2. **Clear Instructions**: Provide clear, specific instructions that describe what the edit should accomplish.

3. **Pattern Structure**: Use the `// ... existing code ...` comments to clearly indicate unchanged sections.

4. **File Organization**: Keep pattern files organized and well-named for reusability.

5. **Session Context**: When possible, run commands from within session workspaces to leverage auto-detection.
