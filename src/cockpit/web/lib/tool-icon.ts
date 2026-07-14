/**
 * Per-family icon selection for the conversation view's unified tool-invocation
 * block (mt#2790) — replaces the universal ⚙ glyph with a family-specific
 * Lucide icon: shell, file ops, git, tasks, memory, subagent spawn, or a
 * generic MCP / native fallback.
 *
 * "MCP (per server)" from the mt#2790 design direction is satisfied at the
 * TEXT layer (the friendly name already shows `<server> · <tool>`, see
 * `friendlyToolName` in `./tool-name.ts`) rather than by minting one icon per
 * server — a per-server icon set would need curation for every MCP server
 * that ever gets wired in and buys little over the text disambiguation
 * already present. The `Plug` icon marks "this came from an MCP server"
 * generically; family-specific icons take priority when a name matches.
 */
import {
  Terminal,
  FileText,
  GitBranch,
  ListTodo,
  BrainCircuit,
  Bot,
  Plug,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ParsedToolName } from "./tool-name";

const SHELL_NAMES = new Set(["Bash", "session_exec"]);

const FILE_NAMES = new Set([
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "session_read_file",
  "session_write_file",
  "session_edit_file",
  "session_edit-file",
  "session_search_replace",
  "session_delete_file",
  "session_move_file",
  "session_rename_file",
  "session_create_directory",
  "session_list_directory",
  "session_file_exists",
  "session_grep_search",
]);

/** Subagent-spawn signal — mirrors `AGENT_TOOL_NAME` in conversation-elements.ts. */
const SPAWN_NAMES = new Set(["Agent", "Task"]);

function isGitTool(name: string): boolean {
  return name.startsWith("git_");
}

function isTaskTool(name: string): boolean {
  return name.startsWith("tasks_");
}

function isMemoryTool(name: string): boolean {
  return name.startsWith("memory_");
}

/** Select a per-family icon for a parsed tool name. */
export function toolIconFor(parsed: ParsedToolName): LucideIcon {
  const { name, server } = parsed;
  if (SPAWN_NAMES.has(name)) return Bot;
  if (SHELL_NAMES.has(name)) return Terminal;
  if (FILE_NAMES.has(name)) return FileText;
  if (isGitTool(name)) return GitBranch;
  if (isTaskTool(name)) return ListTodo;
  if (isMemoryTool(name)) return BrainCircuit;
  if (server) return Plug;
  return Wrench;
}
