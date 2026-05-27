/**
 * Update an existing GitHub App's events and permissions via PATCH /app.
 *
 * @see mt#2167
 */

import { buildAppJwt } from "./app-jwt";
import type { CredentialStore } from "./credential-store";

export interface UpdateGithubAppOptions {
  name: string;
  store: CredentialStore;
  events?: string[];
  permissions?: Record<string, string>;
  execute: boolean;
  apiBaseUrl?: string;
  /** Test seam: override JWT builder to avoid real crypto in tests. */
  buildJwt?: (appId: number, pem: string) => Promise<string>;
}

export interface AppConfig {
  events: string[];
  permissions: Record<string, string>;
}

export interface UpdateGithubAppResult {
  success: boolean;
  message: string;
  dryRun: boolean;
  current?: AppConfig;
  proposed?: AppConfig;
}

interface GitHubAppResponse {
  events: string[];
  permissions: Record<string, string>;
  name: string;
  slug: string;
}

export async function updateGithubApp(
  options: UpdateGithubAppOptions
): Promise<UpdateGithubAppResult> {
  const { name, store, events, permissions, execute, apiBaseUrl } = options;
  const baseUrl = apiBaseUrl ?? "https://api.github.com";
  const jwtBuilder = options.buildJwt ?? buildAppJwt;

  const creds = await store.read(name);
  if (!creds) {
    return {
      success: false,
      message: `No stored credentials found for App '${name}' at the configured credential store.`,
      dryRun: !execute,
    };
  }

  if (!events && !permissions) {
    return {
      success: false,
      message: "Nothing to update: specify --events and/or --permissions.",
      dryRun: !execute,
    };
  }

  const jwt = await jwtBuilder(creds.appId, creds.pem);
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "User-Agent": `${name}-setup`,
  };

  const currentResp = await fetch(`${baseUrl}/app`, { headers });
  if (!currentResp.ok) {
    const body = await currentResp.text();
    return {
      success: false,
      message: `Failed to read current App config (HTTP ${currentResp.status}): ${body}`,
      dryRun: !execute,
    };
  }

  const currentApp = (await currentResp.json()) as GitHubAppResponse;
  const current: AppConfig = {
    events: currentApp.events ?? [],
    permissions: currentApp.permissions ?? {},
  };

  const proposed: AppConfig = {
    events: events ?? current.events,
    permissions: permissions ?? current.permissions,
  };

  if (!execute) {
    return {
      success: true,
      message: formatDryRunMessage(current, proposed),
      dryRun: true,
      current,
      proposed,
    };
  }

  const patchBody: Record<string, unknown> = {};
  if (events) patchBody.default_events = events;
  if (permissions) patchBody.default_permissions = permissions;

  const patchResp = await fetch(`${baseUrl}/app`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(patchBody),
  });

  if (!patchResp.ok) {
    const body = await patchResp.text();
    return {
      success: false,
      message: `PATCH /app failed (HTTP ${patchResp.status}): ${body}`,
      dryRun: false,
      current,
      proposed,
    };
  }

  const verifyResp = await fetch(`${baseUrl}/app`, { headers });
  if (!verifyResp.ok) {
    return {
      success: true,
      message:
        "Update sent successfully but verification read-back failed. Changes may have applied.",
      dryRun: false,
      current,
      proposed,
    };
  }

  const verified = (await verifyResp.json()) as GitHubAppResponse;
  const verifiedConfig: AppConfig = {
    events: verified.events ?? [],
    permissions: verified.permissions ?? {},
  };

  return {
    success: true,
    message: formatSuccessMessage(verifiedConfig),
    dryRun: false,
    current,
    proposed: verifiedConfig,
  };
}

function formatDryRunMessage(current: AppConfig, proposed: AppConfig): string {
  const eventsChanged =
    JSON.stringify(current.events.sort()) !== JSON.stringify(proposed.events.sort());
  const permsChanged = JSON.stringify(current.permissions) !== JSON.stringify(proposed.permissions);

  if (!eventsChanged && !permsChanged) {
    return "No changes — current configuration already matches the requested settings.";
  }

  const lines: string[] = ["Would update App configuration:"];

  if (eventsChanged) {
    lines.push(
      `  Events: [${current.events.sort().join(", ")}] → [${proposed.events.sort().join(", ")}]`
    );
  }
  if (permsChanged) {
    lines.push(
      `  Permissions: ${formatPerms(current.permissions)} → ${formatPerms(proposed.permissions)}`
    );
  }

  lines.push("");
  lines.push("Pass --execute to apply.");
  return lines.join("\n");
}

function formatSuccessMessage(verified: AppConfig): string {
  const lines: string[] = ["App updated successfully."];
  lines.push(`  Events: [${verified.events.sort().join(", ")}]`);
  lines.push(`  Permissions: ${formatPerms(verified.permissions)}`);
  return lines.join("\n");
}

function formatPerms(perms: Record<string, string>): string {
  return Object.entries(perms)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
}
