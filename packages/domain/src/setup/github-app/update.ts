/**
 * Show drift between an existing GitHub App's stored/requested events and
 * permissions and its LIVE configuration, and point at the portal procedure
 * to fix it.
 *
 * GitHub's REST API has no endpoint to mutate an existing App's
 * `default_permissions` / `default_events` — there is no PATCH or PUT under
 * `/app` for this (confirmed against
 * https://docs.github.com/en/rest/apps/apps and
 * https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration,
 * both exclusively web-UI procedures). A prior version of this module issued
 * `PATCH /app`, which 404s on every call — see mt#3218. The only real
 * mutation path is `https://github.com/settings/apps/<slug>/permissions`,
 * and even then a permission CHANGE is a *request*: each account where the
 * App is installed must separately accept it before it takes effect.
 *
 * This module therefore never attempts to mutate anything. It reads the
 * App's current config via `GET /app` (which works), diffs it against the
 * requested events/permissions, and returns an actionable message naming the
 * exact settings URL for THIS App plus the specific fields that differ — so
 * an operator can go make the change in ~60 seconds. `--execute` is accepted
 * for backward compatibility with existing invocations but has no effect on
 * control flow beyond a note in the message; there is no API call left to
 * gate behind it.
 *
 * @see mt#2167 — original PATCH-based implementation
 * @see mt#3218 — this rewrite; the PATCH path never worked
 */

import { buildAppJwt } from "./app-jwt";
import type { CredentialStore } from "./credential-store";

export interface UpdateGithubAppOptions {
  name: string;
  store: CredentialStore;
  events?: string[];
  permissions?: Record<string, string>;
  /** Accepted for backward compatibility; has no effect (see module doc). */
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
  /** Always true: there is no API path that ever applies a mutation. */
  dryRun: boolean;
  current?: AppConfig;
  proposed?: AppConfig;
  /** The App's settings URL, present whenever the current config was read successfully. */
  settingsUrl?: string;
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
  const { name, store, events, permissions, execute } = options;
  const baseUrl = options.apiBaseUrl ?? "https://api.github.com";
  const jwtBuilder = options.buildJwt ?? buildAppJwt;

  const creds = await store.read(name);
  if (!creds) {
    return {
      success: false,
      message: `No stored credentials found for App '${name}' at the configured credential store.`,
      dryRun: true,
    };
  }

  if (!events && !permissions) {
    return {
      success: false,
      message: "Nothing to update: specify --events and/or --permissions.",
      dryRun: true,
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
      dryRun: true,
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

  const settingsUrl = `https://github.com/settings/apps/${currentApp.slug}/permissions`;

  const eventsChanged =
    JSON.stringify([...current.events].sort()) !== JSON.stringify([...proposed.events].sort());
  const permsChanged = !permissionsEqual(current.permissions, proposed.permissions);

  if (!eventsChanged && !permsChanged) {
    return {
      success: true,
      message: "No changes — current configuration already matches the requested settings.",
      dryRun: true,
      current,
      proposed,
      settingsUrl,
    };
  }

  return {
    success: false,
    message: formatActionableMessage({
      current,
      proposed,
      settingsUrl,
      eventsChanged,
      permsChanged,
      executeRequested: execute,
    }),
    dryRun: true,
    current,
    proposed,
    settingsUrl,
  };
}

function formatActionableMessage(args: {
  current: AppConfig;
  proposed: AppConfig;
  settingsUrl: string;
  eventsChanged: boolean;
  permsChanged: boolean;
  executeRequested: boolean;
}): string {
  const { current, proposed, settingsUrl, eventsChanged, permsChanged, executeRequested } = args;
  const lines: string[] = [
    "GitHub has no API to update an existing App's events or permissions " +
      "(confirmed against https://docs.github.com/en/rest/apps/apps) — this command cannot apply " +
      "the change for you.",
    "",
    "Requested change:",
  ];

  if (eventsChanged) {
    lines.push(
      `  Events: [${[...current.events].sort().join(", ")}] -> [${[...proposed.events].sort().join(", ")}]`
    );
  }
  if (permsChanged) {
    lines.push(
      `  Permissions: ${formatPerms(current.permissions)} -> ${formatPerms(proposed.permissions)}`
    );
  }

  lines.push("");
  lines.push(`Apply it manually at: ${settingsUrl}`);
  lines.push(
    "After saving, this is only a *request* — the installing account/org must separately " +
      "accept the new permission set before it takes effect (events do not require acceptance)."
  );

  if (executeRequested) {
    lines.push("");
    lines.push(
      "Note: --execute was passed but has no effect here — there is no API call left to gate " +
        "behind it."
    );
  }

  return lines.join("\n");
}

function formatPerms(perms: Record<string, string>): string {
  return Object.entries(perms)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
}

/**
 * Structural equality for permission maps, independent of key order.
 * `JSON.stringify` compares by insertion order, so two maps with identical
 * key/value pairs inserted in a different order (e.g. GitHub's `GET /app`
 * response vs a `--permissions` string parsed in a different order) would
 * false-positive as "changed" — reviewer finding on PR #2317 R1.
 */
function permissionsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, i) => key === bKeys[i] && a[key] === b[key]);
}
