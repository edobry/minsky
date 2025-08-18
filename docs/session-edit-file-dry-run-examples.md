# Session Edit File Dry-Run Examples

This document provides examples of using the `session.edit_file` MCP tool with dry-run support to preview changes before applying them.

## Overview

The `session.edit_file` tool now supports a `dryRun` parameter that allows you to preview proposed changes without writing to disk. When `dryRun=true`, the tool returns:

- `proposedContent`: The final content that would be written
- `diff`: A unified diff showing changes
- `diffSummary`: Statistics about lines added/removed/changed

## Basic Usage Examples

### Example 1: Preview Edit to Existing File

```javascript
// MCP tool call
await tools.session_edit_file({
  sessionName: "my-session",
  path: "src/utils/helper.ts",
  instructions: "Add error handling to the parseData function",
  content: `// ... existing code ...
function parseData(input: string): ParsedData {
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new Error(\`Failed to parse data: \${error.message}\`);
  }
}
// ... existing code ...`,
  dryRun: true,
});
```

**Response:**

```json
{
  "success": true,
  "timestamp": "2025-01-18T19:00:00.000Z",
  "path": "src/utils/helper.ts",
  "session": "my-session",
  "resolvedPath": "/session/workspace/src/utils/helper.ts",
  "dryRun": true,
  "proposedContent": "function parseData(input: string): ParsedData {\n  try {\n    return JSON.parse(input);\n  } catch (error) {\n    throw new Error(`Failed to parse data: ${error.message}`);\n  }\n}",
  "diff": "--- src/utils/helper.ts\n+++ src/utils/helper.ts\n@@ -1,3 +1,7 @@\n function parseData(input: string): ParsedData {\n-  return JSON.parse(input);\n+  try {\n+    return JSON.parse(input);\n+  } catch (error) {\n+    throw new Error(`Failed to parse data: ${error.message}`);\n+  }\n }",
  "diffSummary": {
    "linesAdded": 4,
    "linesRemoved": 1,
    "linesChanged": 0,
    "totalLines": 7
  },
  "edited": true,
  "created": false
}
```

### Example 2: Preview New File Creation

```javascript
// MCP tool call
await tools.session_edit_file({
  sessionName: "my-session",
  path: "src/types/api.ts",
  instructions: "Create TypeScript interface definitions for API responses",
  content: `export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface UserData {
  id: string;
  username: string;
  email: string;
  createdAt: string;
}`,
  dryRun: true,
});
```

**Response:**

```json
{
  "success": true,
  "timestamp": "2025-01-18T19:00:00.000Z",
  "path": "src/types/api.ts",
  "session": "my-session",
  "resolvedPath": "/session/workspace/src/types/api.ts",
  "dryRun": true,
  "proposedContent": "export interface ApiResponse<T = any> {\n  success: boolean;\n  data?: T;\n  error?: string;\n  timestamp: string;\n}\n\nexport interface UserData {\n  id: string;\n  username: string;\n  email: string;\n  createdAt: string;\n}",
  "diff": "--- src/types/api.ts\n+++ src/types/api.ts\n@@ -0,0 +1,12 @@\n+export interface ApiResponse<T = any> {\n+  success: boolean;\n+  data?: T;\n+  error?: string;\n+  timestamp: string;\n+}\n+\n+export interface UserData {\n+  id: string;\n+  username: string;\n+  email: string;\n+  createdAt: string;\n+}",
  "diffSummary": {
    "linesAdded": 12,
    "linesRemoved": 0,
    "linesChanged": 0,
    "totalLines": 12
  },
  "edited": false,
  "created": true
}
```

### Example 3: Compare Normal vs Dry-Run Mode

#### Dry-Run Mode (Preview Only)

```javascript
// Preview changes first
const preview = await tools.session_edit_file({
  sessionName: "my-session",
  path: "config.json",
  instructions: "Update the API endpoint URL",
  content: `{
  "apiEndpoint": "https://api-v2.example.com",
  "timeout": 5000
}`,
  dryRun: true,
});

console.log("Proposed changes:");
console.log(preview.diff);
console.log("Lines changed:", preview.diffSummary);
```

#### Normal Mode (Apply Changes)

```javascript
// Apply changes after reviewing
const result = await tools.session_edit_file({
  sessionName: "my-session",
  path: "config.json",
  instructions: "Update the API endpoint URL",
  content: `{
  "apiEndpoint": "https://api-v2.example.com",
  "timeout": 5000
}`,
  dryRun: false, // or omit, defaults to false
});

console.log("Changes applied:", result.success);
```

## Advanced Usage Patterns

### Pattern 1: Conditional Application

```javascript
async function safeEdit(sessionName, path, instructions, content) {
  // Always preview first
  const preview = await tools.session_edit_file({
    sessionName,
    path,
    instructions,
    content,
    dryRun: true,
  });

  // Check if changes look reasonable
  if (preview.diffSummary.linesRemoved > 100) {
    throw new Error("Too many lines would be removed, aborting");
  }

  // Apply if safe
  return await tools.session_edit_file({
    sessionName,
    path,
    instructions,
    content,
    dryRun: false,
  });
}
```

### Pattern 2: Diff Review Workflow

```javascript
async function reviewAndApply(sessionName, edits) {
  const previews = [];

  // Generate previews for all edits
  for (const edit of edits) {
    const preview = await tools.session_edit_file({
      ...edit,
      sessionName,
      dryRun: true,
    });
    previews.push({ edit, preview });
  }

  // Review all diffs
  for (const { edit, preview } of previews) {
    console.log(`\n=== Changes for ${edit.path} ===`);
    console.log(preview.diff);
    console.log(`Summary: +${preview.diffSummary.linesAdded} -${preview.diffSummary.linesRemoved}`);
  }

  // Apply all edits
  const results = [];
  for (const { edit } of previews) {
    const result = await tools.session_edit_file({
      ...edit,
      sessionName,
      dryRun: false,
    });
    results.push(result);
  }

  return results;
}
```

## Error Handling

### Invalid Edit Pattern for Non-Existent File

```javascript
try {
  await tools.session_edit_file({
    sessionName: "my-session",
    path: "non-existent.txt",
    instructions: "Try to edit non-existent file",
    content: "// ... existing code ...\nnew line\n// ... existing code ...",
    dryRun: true,
  });
} catch (error) {
  console.error("Error:", error.message);
  // "Cannot apply edits with existing code markers to non-existent file: non-existent.txt"
}
```

## Integration with Other Tools

### Use with Session Management

```javascript
// Start session and preview changes
const session = await tools.session_start({ task: "feature-123" });

const preview = await tools.session_edit_file({
  sessionName: session.session,
  path: "src/feature.ts",
  instructions: "Implement new feature",
  content: "// implementation here",
  dryRun: true,
});

if (userApproves(preview.diff)) {
  await tools.session_edit_file({
    sessionName: session.session,
    path: "src/feature.ts",
    instructions: "Implement new feature",
    content: "// implementation here",
    dryRun: false,
  });
}
```

## Best Practices

1. **Always Preview First**: Use dry-run mode before making any significant changes
2. **Review Diffs**: Check the unified diff output to ensure changes are as expected
3. **Check Statistics**: Use `diffSummary` to validate the scope of changes
4. **Validate Content**: Inspect `proposedContent` for correctness
5. **Error Handling**: Wrap dry-run calls in try-catch blocks for validation errors
6. **Conditional Logic**: Use dry-run results to decide whether to proceed with actual edits

## Response Fields Reference

| Field                      | Type    | Description                                            |
| -------------------------- | ------- | ------------------------------------------------------ |
| `success`                  | boolean | Whether the dry-run completed successfully             |
| `dryRun`                   | boolean | Always `true` for dry-run responses                    |
| `proposedContent`          | string  | The complete file content that would be written        |
| `diff`                     | string  | Unified diff showing changes from original to proposed |
| `diffSummary.linesAdded`   | number  | Number of lines that would be added                    |
| `diffSummary.linesRemoved` | number  | Number of lines that would be removed                  |
| `diffSummary.linesChanged` | number  | Number of lines that would be changed                  |
| `diffSummary.totalLines`   | number  | Total lines in the proposed content                    |
| `edited`                   | boolean | Whether an existing file would be modified             |
| `created`                  | boolean | Whether a new file would be created                    |
| `path`                     | string  | The file path within the session workspace             |
| `session`                  | string  | The session identifier                                 |
| `resolvedPath`             | string  | The full resolved file path                            |

## Notes

- Dry-run mode never writes to disk or creates directories
- File system operations (`createDirs`) are ignored in dry-run mode
- Edit pattern validation still applies (cannot use `// ... existing code ...` on non-existent files)
- The diff format follows standard unified diff conventions
- Statistics are calculated positionally, so line moves may show as additions + removals
