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
  Search,
  Clock,
  MessageCircle,
  Layers,
  User,
  ShieldAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ParsedToolName } from "./tool-name";
import type { EventActorKind, EventVerb } from "@minsky/domain/transcripts/event-schema";

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

// ── Session-film glyphic-ribbon icons (mt#3226 SC 2) ────────────────────────
//
// The session film's ribbon rows are keyed on the semantic-event VERB
// vocabulary (event-schema.ts's EventVerb), not a raw tool name — a
// different axis than `toolIconFor` above, but deliberately kept in this
// SAME shared file (not a bespoke duplicate icon set in a session-film-only
// module) so both the conversation view's tool-invocation icons and the
// session film's ribbon glyphs draw from one registry and stay visually
// consistent for the same underlying action family (e.g. a `Read` tool call
// and a `read` semantic-event verb both read as "looking at something").

/** Per-verb icon for the session film's glyphic ribbon row (mt#3226 SC 2 / AT 3). */
export function verbIconFor(verb: EventVerb): LucideIcon {
  switch (verb) {
    case "read":
    case "search":
      return Search;
    case "write":
    case "create":
    case "delete":
      return FileText;
    case "clone":
      return GitBranch;
    case "execute":
      return Terminal;
    case "spawn":
      return Bot;
    case "wait":
      return Clock;
    case "speak":
    case "respond":
    case "ask":
      return MessageCircle;
    case "think":
      return BrainCircuit;
    default:
      return Wrench;
  }
}

/**
 * Human-readable label per verb (mt#3231 SC 2 / AT 2 — "icon labels/badges"):
 * a short WORD beside the icon, since a bare glyph alone under-communicates
 * ("Read"/"Write"/"Search"/"Think"/"Wait"/"Spawn"/"Ask" per the operator's
 * finding). Kept in this SAME shared registry (not a bespoke ribbon-only
 * label map) so a future legend or any other verb-icon consumer draws from
 * one source, per the module doc's "ribbon and any future legend share one
 * source" convention.
 */
export function verbLabelFor(verb: EventVerb): string {
  switch (verb) {
    case "read":
      return "Read";
    case "search":
      return "Search";
    case "write":
      return "Write";
    case "create":
      return "Create";
    case "delete":
      return "Delete";
    case "clone":
      return "Clone";
    case "execute":
      return "Run";
    case "spawn":
      return "Spawn";
    case "wait":
      return "Wait";
    case "speak":
      return "Speak";
    case "think":
      return "Think";
    case "ask":
      return "Ask";
    case "respond":
      return "Respond";
    default:
      return "Act";
  }
}

/** Icon for a collapsed parallel-batch row (>1 simultaneous event) — distinct from any single verb. */
export const BATCH_ROW_ICON: LucideIcon = Layers;

/** Label for a collapsed parallel-batch row's icon badge (mt#3231 SC 2). */
export const BATCH_ROW_LABEL = "Batch";

/** Per-actor-kind icon for the session film's actor-change marker (mt#3226 SC 2). */
export function actorIconFor(kind: EventActorKind): LucideIcon {
  if (kind === "principal") return User;
  if (kind === "policy") return ShieldAlert;
  return Bot;
}
