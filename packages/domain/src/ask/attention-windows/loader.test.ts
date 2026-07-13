/**
 * Tests for the attention-window YAML loader — mt#1489.
 *
 * Uses an in-memory `LoaderFs` implementation so no real filesystem access
 * is required. The mock `existsSync` and `readFileSync` operate on a plain
 * `Map<string, string>` keyed by path.
 */

import { describe, test, expect } from "bun:test";
import { loadAttentionWindows, loadAttentionWindowsOrThrow, type LoaderFs } from "./loader";
import { DEFAULT_ATTENTION_WINDOWS } from "./config";

// ---------------------------------------------------------------------------
// In-memory filesystem mock
// ---------------------------------------------------------------------------

/**
 * Build a `LoaderFs` implementation backed by a plain object map.
 *
 * Pass `files` as `{ "/some/path": "file content" }`. Any path not present
 * in the map is treated as non-existent.
 */
function makeMemFs(files: Record<string, string> = {}): LoaderFs {
  const store = new Map(Object.entries(files));
  return {
    existsSync(path: string): boolean {
      return store.has(path);
    },
    readFileSync(path: string, _encoding: "utf8"): string {
      const content = store.get(path);
      if (content === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return content;
    },
  };
}

// The config path is resolved via getUserConfigDir() + "/attention.yaml".
// In tests we need to know what that resolves to so we can set the
// corresponding key in our mock fs. We derive it from the same function
// the loader uses, without touching disk.
import { getAttentionConfigPath } from "./loader";

const CONFIG_PATH = getAttentionConfigPath();

// ---------------------------------------------------------------------------
// First-run defaults
// ---------------------------------------------------------------------------

describe("loadAttentionWindows — first-run defaults", () => {
  test("returns default windows when no file exists", () => {
    const fs = makeMemFs({}); // empty — file absent
    const result = loadAttentionWindows(fs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.fromDefaults).toBe(true);
    expect(result.windows.length).toBeGreaterThan(0);
    const first = result.windows[0];
    if (!first) throw new Error("expected at least one default window");
    expect(first.key).toBe("ask-hours");
    // Verify it returned the actual defaults object
    expect(result.windows).toEqual(DEFAULT_ATTENTION_WINDOWS);
  });
});

// ---------------------------------------------------------------------------
// Valid config
// ---------------------------------------------------------------------------

describe("loadAttentionWindows — valid YAML", () => {
  test("parses a minimal valid config", () => {
    const yaml = `
windows:
  ask-hours:
    schedule: "0 16 * * 1-5"
    durationMin: 30
    maxMisses: 2
    description: "Daily 4pm window"
`;
    const fs = makeMemFs({ [CONFIG_PATH]: yaml });
    const result = loadAttentionWindows(fs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.fromDefaults).toBe(false);
    expect(result.windows).toHaveLength(1);

    const w = result.windows[0];
    if (!w) throw new Error("expected window");
    expect(w.key).toBe("ask-hours");
    expect(w.schedule).toEqual({ type: "cron", expr: "0 16 * * 1-5" });
    expect(w.durationMin).toBe(30);
    expect(w.maxMisses).toBe(2);
    expect(w.description).toBe("Daily 4pm window");
  });

  test("normalises schedule:manual to { type: 'manual' }", () => {
    const yaml = `
windows:
  on-demand:
    schedule: manual
    durationMin: 30
    maxMisses: -1
`;
    const fs = makeMemFs({ [CONFIG_PATH]: yaml });
    const result = loadAttentionWindows(fs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const w = result.windows[0];
    if (!w) throw new Error("expected window");
    expect(w.schedule).toEqual({ type: "manual" });
    expect(w.maxMisses).toBe(-1);
  });

  test("parses multiple windows", () => {
    const yaml = `
windows:
  ask-hours:
    schedule: "0 16 * * 1-5"
    durationMin: 30
    maxMisses: 2
  weekly-review:
    schedule: "0 10 * * 1"
    durationMin: 60
    maxMisses: 1
  on-demand:
    schedule: manual
    durationMin: 20
    maxMisses: -1
`;
    const fs = makeMemFs({ [CONFIG_PATH]: yaml });
    const result = loadAttentionWindows(fs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.windows).toHaveLength(3);
    const keys = result.windows.map((w) => w.key);
    expect(keys).toContain("ask-hours");
    expect(keys).toContain("weekly-review");
    expect(keys).toContain("on-demand");
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("loadAttentionWindows — validation errors", () => {
  test("returns ok:false for YAML parse error", () => {
    const yaml = `
windows:
  broken: [unclosed
`;
    const fs = makeMemFs({ [CONFIG_PATH]: yaml });
    const result = loadAttentionWindows(fs);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.length).toBeGreaterThan(0);
    const firstError = result.errors[0];
    if (!firstError) throw new Error("expected at least one error");
    expect(firstError.message).toContain("YAML parse error");
  });

  test("returns ok:false when durationMin is missing", () => {
    const yaml = `
windows:
  bad-window:
    schedule: "0 16 * * 1-5"
    maxMisses: 2
`;
    const fs = makeMemFs({ [CONFIG_PATH]: yaml });
    const result = loadAttentionWindows(fs);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(
      result.errors.some((e) => e.path.includes("durationMin") || e.path.includes("bad-window"))
    ).toBe(true);
  });

  test("returns ok:false when maxMisses is out of range", () => {
    const yaml = `
windows:
  bad-window:
    schedule: "0 16 * * 1-5"
    durationMin: 30
    maxMisses: -5
`;
    const fs = makeMemFs({ [CONFIG_PATH]: yaml });
    const result = loadAttentionWindows(fs);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("loadAttentionWindowsOrThrow throws on invalid config", () => {
    const yaml = `
windows:
  bad-window:
    schedule: "0 16 * * 1-5"
    maxMisses: 2
`;
    const fs = makeMemFs({ [CONFIG_PATH]: yaml });
    expect(() => loadAttentionWindowsOrThrow(fs)).toThrow("Attention window configuration errors");
  });
});
