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

const DEFAULT_CONFIG: CockpitConfig = {
  widgets: [
    { id: "attention-stub", enabled: true },
    { id: "basic-health", enabled: true },
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
