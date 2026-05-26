/**
 * Preference-encoding action filter — Surface 1 of the System 3* detector.
 *
 * Decides whether a PreToolUse tool call encodes a preference-bound choice
 * that requires policy coverage. Per mt#1035 §Preference-encoding action filter.
 *
 * Fires on:
 *   - Write / Edit / NotebookEdit against new files or session-untouched files
 *   - New dependency (package.json edit)
 *   - New config key (json/yaml/toml file addition)
 *   - New user-facing string (i18n / error-message / CLI-help text patterns)
 *   - New top-level name without precedent (new exported class/function)
 *
 * Does NOT fire on:
 *   - Read, Glob, Grep, list-directory, status-check tool calls
 *   - Internal file operations without preference-encoding patterns
 *
 * Reference: docs/research/mt1035-system3-detector.md §Preference-encoding action filter
 */

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "Bash",
  // MCP session tools that are read-only
  "mcp__minsky__session_read_file",
  "mcp__minsky__session_list_directory",
  "mcp__minsky__session_grep_search",
  "mcp__minsky__session_search",
  "mcp__minsky__session_status",
  "mcp__minsky__session_diff",
  "mcp__minsky__session_get",
  "mcp__minsky__session_list",
  "mcp__minsky__git_log",
  "mcp__minsky__git_diff",
  "mcp__minsky__git_blame",
  "mcp__minsky__tasks_get",
  "mcp__minsky__tasks_list",
  "mcp__minsky__tasks_spec_get",
]);

// mt#2029: include MCP-session file-write tools alongside the Claude Code
// native tools. The agent uses session_* tools exclusively inside Minsky
// sessions per `Git and MCP tool usage`; absence here means the filter
// silently no-ops on the surface where the agent actually works.
const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "NotebookEdit",
  "mcp__minsky__session_edit_file",
  "mcp__minsky__session_search_replace",
  "mcp__minsky__session_write_file",
]);

// Tool-equivalence helpers (mt#2029). The action-filter has pattern branches
// gated on tool-name shape ("create-or-overwrite" vs "in-place-modify"). The
// MCP session tools have direct equivalents, but their names differ — these
// helpers classify by operational shape rather than literal name so adding a
// new write-tool variant requires updating only this file.
function isCreateOrOverwriteTool(toolName: string): boolean {
  return toolName === "Write" || toolName === "mcp__minsky__session_write_file";
}

function isInPlaceModifyTool(toolName: string): boolean {
  // mt#2029 R1: NotebookEdit is in WRITE_TOOLS but intentionally excluded here.
  // Pre-mt#2029, Pattern 4 (new top-level export) fired only on `Write` or
  // `Edit && !oldString` — NotebookEdit was never in that branch. Including
  // it via the in-place-modify helper would silently expand the firing
  // surface to .ipynb cells, an unintended scope change. If NotebookEdit
  // parity becomes desired, add it here with a test fixture demonstrating
  // intended behavior.
  return (
    toolName === "Edit" ||
    toolName === "mcp__minsky__session_edit_file" ||
    toolName === "mcp__minsky__session_search_replace"
  );
}

/**
 * Reasons why an action was classified as preference-encoding.
 * Used for evidence generation and calibration logging.
 */
export type FilterReason =
  | "new-file"
  | "new-dependency"
  | "new-config-key"
  | "new-user-facing-string"
  | "new-top-level-export";

/**
 * Result of applying the action filter to a tool call.
 */
export type FilterResult = { fires: true; reason: FilterReason; detail: string } | { fires: false };

/**
 * Parameters extracted from a tool call for filter evaluation.
 */
export interface ToolCallParams {
  toolName: string;
  filePath?: string;
  content?: string;
  newString?: string;
  oldString?: string;
}

/**
 * Extract filter-relevant fields from raw tool_input params.
 *
 * Validates with typeof checks — never destructures raw input directly.
 */
export function extractToolCallParams(
  toolName: string,
  params: Record<string, unknown>
): ToolCallParams {
  const filePath =
    typeof params["file_path"] === "string"
      ? params["file_path"]
      : typeof params["path"] === "string"
        ? params["path"]
        : undefined;

  const content = typeof params["content"] === "string" ? params["content"] : undefined;

  // mt#2029: `mcp__minsky__session_search_replace` exposes `search` and
  // `replace` aliases for `old_string` and `new_string` (see the tool's
  // schema). Without these aliases, the detector silently sees empty
  // old/new strings on session_search_replace calls and the action-filter
  // under-fires.
  const newString =
    typeof params["new_string"] === "string"
      ? params["new_string"]
      : typeof params["replace"] === "string"
        ? params["replace"]
        : undefined;

  const oldString =
    typeof params["old_string"] === "string"
      ? params["old_string"]
      : typeof params["search"] === "string"
        ? params["search"]
        : undefined;

  return { toolName, filePath, content, newString, oldString };
}

/**
 * Detect whether a file path targets a package.json (dependency change).
 */
export function isPackageJson(filePath: string): boolean {
  return filePath.endsWith("package.json");
}

/**
 * Detect whether a file path targets a config file (json/yaml/toml).
 */
export function isConfigFile(filePath: string): boolean {
  return (
    filePath.endsWith(".json") ||
    filePath.endsWith(".yaml") ||
    filePath.endsWith(".yml") ||
    filePath.endsWith(".toml") ||
    filePath.endsWith(".env") ||
    filePath.endsWith(".env.example") ||
    // Also match config-like paths
    filePath.includes("config") ||
    filePath.includes(".mdc")
  );
}

/**
 * Detect whether content contains new user-facing string patterns.
 *
 * Matches:
 *   - i18n-style keys or translation strings
 *   - Error messages (throw new Error(...) or similar)
 *   - CLI help text (description:, help:, yargs, commander patterns)
 */
export function hasNewUserFacingString(content: string): boolean {
  // CLI help text patterns (commander, yargs, program descriptions)
  if (/\.(description|helpText|help)\s*[=(]\s*["'`]/.test(content)) return true;
  // Direct help string assignment
  if (/\bhelp\b.*:\s*["'`]/.test(content)) return true;
  // Error messages with specific values
  if (/throw new \w*Error\s*\(["'`]/.test(content)) return true;
  // Console output with specific strings
  if (/console\.(log|error|warn|info)\s*\(["'`]/.test(content)) return true;
  // i18n keys
  if (/t\s*\(\s*["'`][a-z][a-zA-Z_.]+["'`]/.test(content)) return true;
  return false;
}

/**
 * Detect whether content introduces a new top-level export name.
 *
 * Matches exported declarations that represent named preferences (class names,
 * function names, const names) in TypeScript/JavaScript files.
 */
export function hasNewTopLevelExport(content: string): boolean {
  return (
    /^export\s+(class|function|const|interface|type|enum)\s+\w+/m.test(content) ||
    /^export\s+default\s+/m.test(content)
  );
}

/**
 * Detect whether an Edit's new_string introduces a new config key in a JSON/YAML/TOML file.
 *
 * Heuristic: the new_string contains a key:value pattern not in old_string.
 * This catches additions like `"timeout": 14 * 24 * 60 * 60` or `maxRetries: 3`.
 */
export function hasNewConfigKey(newString: string, oldString: string | undefined): boolean {
  // JSON-style key: "key": value
  const jsonKeyPattern = /^\s*"[\w-]+":\s*.+/m;
  // YAML/TOML key: key: value or key = value
  const yamlKeyPattern = /^\s*[\w-]+\s*[:=]\s*.+/m;

  const hasNewKey = jsonKeyPattern.test(newString) || yamlKeyPattern.test(newString);
  if (!hasNewKey) return false;

  // If we have an old string and it already has the same keys, not a new addition
  if (oldString && (jsonKeyPattern.test(oldString) || yamlKeyPattern.test(oldString))) {
    // Check for genuinely new keys in newString not present in oldString
    const newKeys = extractKeys(newString);
    const oldKeys = extractKeys(oldString);
    return newKeys.some((k) => !oldKeys.includes(k));
  }

  // No old string means it's a fresh addition
  return !oldString;
}

/**
 * Extract simple key names from a config-like string.
 */
function extractKeys(content: string): string[] {
  const keys: string[] = [];
  // JSON-style
  for (const m of content.matchAll(/"([\w-]+)":\s*/g)) {
    if (m[1]) keys.push(m[1]);
  }
  // YAML/TOML-style
  for (const m of content.matchAll(/^([\w-]+)\s*[:=]/gm)) {
    if (m[1]) keys.push(m[1]);
  }
  return keys;
}

/**
 * Apply the preference-encoding action filter to a tool call.
 *
 * Returns `{ fires: true, reason, detail }` if the call encodes a preference,
 * or `{ fires: false }` if it is routine and requires no policy coverage.
 */
export function applyActionFilter(params: ToolCallParams): FilterResult {
  const { toolName, filePath, content, newString, oldString } = params;

  // Read-only tools never fire.
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { fires: false };
  }

  // Only write tools are candidates.
  if (!WRITE_TOOLS.has(toolName)) {
    return { fires: false };
  }

  // No file path → can't evaluate patterns.
  if (!filePath) {
    return { fires: false };
  }

  const writtenContent = content ?? newString ?? "";

  // Pattern 1: package.json → new dependency
  if (isPackageJson(filePath)) {
    return {
      fires: true,
      reason: "new-dependency",
      detail: `Edit to ${filePath} may introduce a new dependency`,
    };
  }

  // Pattern 2: config file with new key
  if (isConfigFile(filePath)) {
    if (hasNewConfigKey(writtenContent, oldString)) {
      return {
        fires: true,
        reason: "new-config-key",
        detail: `Edit to ${filePath} introduces a new config key`,
      };
    }
  }

  // Pattern 3: new user-facing string (any TS/JS file)
  if (
    (filePath.endsWith(".ts") || filePath.endsWith(".js") || filePath.endsWith(".tsx")) &&
    hasNewUserFacingString(writtenContent)
  ) {
    return {
      fires: true,
      reason: "new-user-facing-string",
      detail: `Edit to ${filePath} introduces a new user-facing string`,
    };
  }

  // Pattern 4: new top-level export (TypeScript/JavaScript)
  // mt#2029: gate on operational shape (create-or-overwrite OR in-place-modify-
  // without-prior-content) rather than literal Claude Code tool names, so
  // session_write_file / session_edit_file / session_search_replace fire
  // identically to Write / Edit. The pre-mt#2029 condition
  // `toolName === "Write" || (toolName === "Edit" && !oldString)` is the
  // semantic equivalent expressed in the new helpers.
  if (
    (filePath.endsWith(".ts") || filePath.endsWith(".js") || filePath.endsWith(".tsx")) &&
    hasNewTopLevelExport(writtenContent) &&
    (isCreateOrOverwriteTool(toolName) || (isInPlaceModifyTool(toolName) && !oldString))
  ) {
    return {
      fires: true,
      reason: "new-top-level-export",
      detail: `Write to ${filePath} introduces a new exported name`,
    };
  }

  // Pattern 5: new-file fallback — any create-or-overwrite tool that didn't
  // hit a more specific pattern above. Includes Write and session_write_file.
  if (isCreateOrOverwriteTool(toolName)) {
    return {
      fires: true,
      reason: "new-file",
      detail: `${toolName} creates or overwrites ${filePath}`,
    };
  }

  return { fires: false };
}
