/**
 * Attention Window config loader — mt#1489.
 *
 * Reads `~/.config/minsky/attention.yaml` (resolved via the existing config
 * layer's `getUserConfigDir`) and returns a typed `AttentionWindowConfig[]`.
 *
 * Validation errors surface with file:line context from the Zod schema.
 * When no file is present the built-in DEFAULT_ATTENTION_WINDOWS are returned
 * so v0 is dogfoodable out-of-the-box.
 *
 * Filesystem operations are injectable via the `LoaderDeps` parameter so
 * tests can supply in-memory implementations without touching real disk.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";
import type { ZodIssue } from "zod";
import {
  rawAttentionConfigSchema,
  DEFAULT_ATTENTION_WINDOWS,
  type AttentionWindowConfig,
  type RawWindowEntry,
} from "./config";
import { getUserConfigDir } from "../../configuration/sources/user";

// ---------------------------------------------------------------------------
// Injectable filesystem interface
// ---------------------------------------------------------------------------

/**
 * Subset of the Node `fs` module that the loader requires.
 *
 * Accepting this as an optional parameter lets tests inject an in-memory
 * implementation without mocking the real `fs` module.
 */
export interface LoaderFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
}

/** Production implementation backed by real `fs`. */
export const realLoaderFs: LoaderFs = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding) as string,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Path to the attention config file (resolved at call time to honour env overrides). */
export function getAttentionConfigPath(): string {
  return join(getUserConfigDir(), "attention.yaml");
}

/** Validation error reported by the loader. */
export interface AttentionConfigValidationError {
  /** Human-readable message with file:field context. */
  message: string;
  /** Dot-separated field path inside the YAML (e.g. "windows.ask-hours.durationMin"). */
  path: string;
  /** Raw Zod issue for callers that need more detail. */
  issue: ZodIssue;
}

/** Result returned by `loadAttentionWindows`. */
export type AttentionWindowsLoadResult =
  | { ok: true; windows: AttentionWindowConfig[]; fromDefaults: boolean; configPath: string }
  | { ok: false; errors: AttentionConfigValidationError[]; configPath: string };

/**
 * Load attention window config from `~/.config/minsky/attention.yaml`.
 *
 * - File absent -> returns default windows (`fromDefaults: true`).
 * - File present but unparseable -> returns `ok: false` with parse error.
 * - File present but schema-invalid -> returns `ok: false` with field-level errors.
 * - File valid -> returns typed `AttentionWindowConfig[]`.
 *
 * Does NOT throw; all error paths are encoded in the return type.
 *
 * @param deps Filesystem interface — defaults to real `fs`. Override in tests
 *   to avoid touching disk.
 */
export function loadAttentionWindows(deps: LoaderFs = realLoaderFs): AttentionWindowsLoadResult {
  const configPath = getAttentionConfigPath();

  if (!deps.existsSync(configPath)) {
    return { ok: true, windows: DEFAULT_ATTENTION_WINDOWS, fromDefaults: true, configPath };
  }

  let raw: unknown;
  try {
    const content = deps.readFileSync(configPath, "utf8");
    raw = parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [
        {
          message: `${configPath}: YAML parse error - ${message}`,
          path: "",
          issue: {
            code: "custom",
            message: `YAML parse error: ${message}`,
            path: [],
          } as ZodIssue,
        },
      ],
      configPath,
    };
  }

  const parsed = rawAttentionConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: AttentionConfigValidationError[] = parsed.error.issues.map((issue) => {
      const dotPath = issue.path.join(".");
      return {
        message: `${configPath}: ${dotPath ? `${dotPath}: ` : ""}${issue.message}`,
        path: dotPath,
        issue,
      };
    });
    return { ok: false, errors, configPath };
  }

  const windows = resolveWindows(parsed.data.windows);
  return { ok: true, windows, fromDefaults: false, configPath };
}

/**
 * Convenience wrapper that throws on validation failure.
 *
 * Use this inside command `execute` handlers where a hard stop is appropriate.
 *
 * @param deps Optional filesystem interface override (for testing).
 * @throws {Error} When the config file is present but invalid.
 */
export function loadAttentionWindowsOrThrow(
  deps: LoaderFs = realLoaderFs
): AttentionWindowConfig[] {
  const result = loadAttentionWindows(deps);
  if (!result.ok) {
    const lines = result.errors.map((e) => `  - ${e.message}`).join("\n");
    throw new Error(`Attention window configuration errors:\n${lines}`);
  }
  return result.windows;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert the raw YAML map into resolved `AttentionWindowConfig[]`. */
function resolveWindows(rawMap: Record<string, RawWindowEntry>): AttentionWindowConfig[] {
  return Object.entries(rawMap).map(([key, entry]) => {
    const schedule: AttentionWindowConfig["schedule"] =
      entry.schedule === "manual" ? { type: "manual" } : { type: "cron", expr: entry.schedule };

    return {
      key,
      schedule,
      durationMin: entry.durationMin,
      maxMisses: entry.maxMisses,
      description: entry.description,
    };
  });
}
