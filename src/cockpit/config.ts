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

export function loadCockpitConfig(): CockpitConfig {
  const configPath = path.join(os.homedir(), ".config", "minsky", "cockpit.json");
  try {
    const raw = String(fs.readFileSync(configPath));
    const parsed = JSON.parse(raw) as CockpitConfig;
    return parsed;
  } catch {
    return DEFAULT_CONFIG;
  }
}
