/**
 * Config doctor auto-fixes (mt#2679).
 *
 * `config doctor` historically DETECTED gaps but left remediation to the
 * operator — the in-band-portal anti-pattern (`decision-defaults §Turnkey,
 * not portal`). Four incidents in 20 days (see mt#2679) hit the same missing
 * `mcp.auth.token`: the secret existed on the laptop the whole time, in
 * `~/.config/minsky/railway-secrets.json` (the deploy synthesizer's secret
 * store), which the config loader never reads. Each incident's agent saw an
 * empty config, deferred to "operator sets it", and the loop never closed.
 *
 * This module gives doctor a fix surface: when a diagnostic has a mechanical
 * remediation whose inputs are already on disk, `doctor --fix` performs it
 * in-band instead of printing an instruction.
 *
 * Secret hygiene: fix outcomes NEVER include the secret value in any message
 * (mt#2702 tracks the sibling `config set` echo defect).
 */

import { join } from "path";
import type { DoctorDiagnostic } from "./validate-doctor-commands";

/** Filename of the deploy-synthesizer secret store inside the user config dir. */
export const RAILWAY_SECRETS_FILENAME = "railway-secrets.json";

/** The secrets-file key holding the MCP bearer token (canonical name, mt#1825). */
export const MCP_AUTH_TOKEN_SECRET_KEY = "MINSKY_MCP_AUTH_TOKEN";

/** Config dot-path the token is provisioned into. */
export const MCP_AUTH_TOKEN_CONFIG_KEY = "mcp.auth.token";

/**
 * Minimal writer seam — matches `createConfigWriter().setConfigValue`'s
 * shape so tests inject a fake without touching the real user config.
 */
export interface ConfigValueWriter {
  setConfigValue(
    key: string,
    value: unknown
  ): Promise<{ success: boolean; error?: string; filePath?: string }>;
}

/** Injectable dependencies for {@link fixMcpAuthTokenFromSecretsFile}. */
export interface McpAuthTokenFixDeps {
  /** User config directory (e.g. `~/.config/minsky`). */
  configDir: string;
  /** Reads a file as UTF-8, throwing on absence (fs.readFileSync shape). */
  readFile: (path: string) => string;
  /** Config writer used to persist the provisioned key. */
  writer: ConfigValueWriter;
}

/**
 * Provision `mcp.auth.token` from the local railway-secrets store.
 *
 * Preconditions checked in order; the first miss returns a non-fixed
 * diagnostic naming the gap (never the secret value):
 *   1. `<configDir>/railway-secrets.json` exists and is readable.
 *   2. It parses as a JSON object.
 *   3. It carries a non-empty string `MINSKY_MCP_AUTH_TOKEN`.
 *
 * On success, writes `mcp.auth.token` via the injected config writer (the
 * same structured write path `config set` uses — file backup + validation
 * included) and reports WHERE the value came from, not what it is.
 */
export async function fixMcpAuthTokenFromSecretsFile(
  deps: McpAuthTokenFixDeps
): Promise<DoctorDiagnostic> {
  const secretsPath = join(deps.configDir, RAILWAY_SECRETS_FILENAME);

  let raw: string;
  try {
    raw = deps.readFile(secretsPath);
  } catch {
    return {
      check: "Reviewer Retrigger Reachability (fix)",
      status: "warning",
      message:
        `Cannot auto-provision \`${MCP_AUTH_TOKEN_CONFIG_KEY}\`: no readable ` +
        `${RAILWAY_SECRETS_FILENAME} at ${secretsPath}.`,
      suggestion:
        `Set ${MCP_AUTH_TOKEN_CONFIG_KEY} via \`minsky config set\`, or export ` +
        `${MCP_AUTH_TOKEN_SECRET_KEY}.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      check: "Reviewer Retrigger Reachability (fix)",
      status: "warning",
      message: `Cannot auto-provision \`${MCP_AUTH_TOKEN_CONFIG_KEY}\`: ${secretsPath} is not valid JSON.`,
    };
  }

  const token =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)[MCP_AUTH_TOKEN_SECRET_KEY]
      : undefined;
  if (typeof token !== "string" || token.trim() === "") {
    return {
      check: "Reviewer Retrigger Reachability (fix)",
      status: "warning",
      message:
        `Cannot auto-provision \`${MCP_AUTH_TOKEN_CONFIG_KEY}\`: ${secretsPath} has no ` +
        `non-empty \`${MCP_AUTH_TOKEN_SECRET_KEY}\` entry.`,
    };
  }

  // Sanity-gate the token shape (PR #1855 R1 — token sanitation robustness):
  // a bearer token is printable non-whitespace ASCII. Interior whitespace or
  // control characters indicate a corrupted/mispasted secrets entry — writing
  // it through would produce confusing 401s at use time far from the cause.
  const trimmedToken = token.trim();
  if (!/^[\x21-\x7e]+$/.test(trimmedToken)) {
    return {
      check: "Reviewer Retrigger Reachability (fix)",
      status: "warning",
      message:
        `Cannot auto-provision \`${MCP_AUTH_TOKEN_CONFIG_KEY}\`: the ` +
        `\`${MCP_AUTH_TOKEN_SECRET_KEY}\` entry in ${secretsPath} contains whitespace or ` +
        `non-printable characters — fix the secrets file entry first.`,
    };
  }

  const result = await deps.writer.setConfigValue(MCP_AUTH_TOKEN_CONFIG_KEY, trimmedToken);
  if (!result.success) {
    return {
      check: "Reviewer Retrigger Reachability (fix)",
      status: "error",
      message: `Auto-provisioning \`${MCP_AUTH_TOKEN_CONFIG_KEY}\` failed: ${result.error ?? "unknown write error"}.`,
    };
  }

  return {
    check: "Reviewer Retrigger Reachability (fix)",
    status: "pass",
    message:
      `Provisioned \`${MCP_AUTH_TOKEN_CONFIG_KEY}\` from ${RAILWAY_SECRETS_FILENAME}` +
      `${result.filePath ? ` into ${result.filePath}` : ""}. ` +
      `Restart or reconnect long-lived processes (MCP servers cache config at boot — mt#1427).`,
  };
}
