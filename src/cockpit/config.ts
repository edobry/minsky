// cockpit-preview smoke test trigger (mt#2117 — safe to remove after verification)
/**
 * Cockpit config loader (mt#1144)
 *
 * Reads ~/.config/minsky/cockpit.json.
 * If the file is absent or unreadable, returns a default config that enables
 * both built-in placeholder widgets.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { CockpitConfig } from "./types";

// Agents (mt#1145) is the first real-data widget — it reads from the session
// DB on every poll. Defaulting it to `enabled: false` lets users opt in
// explicitly so the cockpit's first-run behavior stays bound to placeholder
// widgets. Per PR #1030 R1 reviewer finding.
const DEFAULT_CONFIG: CockpitConfig = {
  widgets: [
    { id: "agents", enabled: false },
    // attention (mt#1147) replaces the retired attention-stub. Real-data widget
    // reading from the asks table; defaults to enabled because surfacing pending
    // operator-routed asks is the cockpit's primary v0 value-add. Gracefully
    // degrades when no DB is available.
    { id: "attention", enabled: true },
    { id: "basic-health", enabled: true },
    // context-inspector (mt#2023) — observation surface for per-session context
    // composition. Real-data widget reading from agent_transcripts + the new
    // agent_transcript_attachments table. Defaults to `enabled: false` to
    // match the agents / task-graph / workstreams opt-in pattern (PR #1030 R1):
    // the cockpit's first-run behavior stays bound to placeholder widgets
    // until operators opt in explicitly. Gracefully degrades when the SQL
    // provider isn't available.
    { id: "context-inspector", enabled: false },
    // credentials (mt#1426) — credential lifecycle surface. Defaults to enabled
    // because credentials setup is a first-run concern; operators need to see
    // and manage credentials from the cockpit home. No external dependency;
    // reads from ~/.config/minsky/config.yaml and credentials-meta.json.
    { id: "credentials", enabled: true },
    // task-graph (mt#1146) is a real-data widget reading from the task DB.
    // Defaulting to `enabled: false` lets users opt in explicitly so the
    // cockpit's first-run behavior stays bound to placeholder widgets.
    // Same pattern as the agents widget (PR #1030 R1).
    { id: "task-graph", enabled: false },
    // workstreams (mt#1452) is a real-data widget reading from the task DB.
    // Defaulting to `enabled: false` — same opt-in pattern as agents and task-graph.
    { id: "workstreams", enabled: false },
  ],
};

/**
 * Validate that a parsed JSON value is a well-formed CockpitConfig.
 * Returns true only if the value is an object with `widgets` as an array of
 * `{ id: string; enabled: boolean }` entries.
 */
function isValidConfig(value: unknown): value is CockpitConfig {
  if (typeof value !== "object" || value === null) return false;
  const widgets = (value as { widgets?: unknown }).widgets;
  if (!Array.isArray(widgets)) return false;
  return widgets.every(
    (w): w is { id: string; enabled: boolean } =>
      typeof w === "object" &&
      w !== null &&
      typeof (w as { id?: unknown }).id === "string" &&
      typeof (w as { enabled?: unknown }).enabled === "boolean"
  );
}

export function loadCockpitConfig(): CockpitConfig {
  const configPath = path.join(os.homedir(), ".config", "minsky", "cockpit.json");
  try {
    const raw = String(fs.readFileSync(configPath));
    const parsed: unknown = JSON.parse(raw);
    if (isValidConfig(parsed)) {
      return parsed;
    }
    // Malformed config — fall back to default rather than crash on startup.
    return DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}
