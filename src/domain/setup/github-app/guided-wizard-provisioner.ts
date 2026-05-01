/**
 * GuidedWizardProvisioner — interactive prompts + manual credential entry.
 *
 * For environments where the manifest flow can't run: restricted SSO orgs,
 * air-gapped setups, or browsers/ports the user can't reach. Also serves as
 * a starting point for GitHub Enterprise (configure `apiBaseUrl` and
 * `webBaseUrl` for non-github.com hosts; full GHE support is a follow-up
 * beyond v1).
 *
 * Walks the user through the GitHub portal steps, prompts to paste the App ID,
 * installation ID, and PEM contents, then validates the PEM by signing a JWT
 * and calling /app on the configured API host.
 *
 * @see mt#1087
 */

import * as clack from "@clack/prompts";
import type { AppProvisioner } from "./provisioner";
import { BrowserCancelledError } from "./provisioner";
import type { AppManifestSpec, AppCredentials } from "./types";
import { pemToPkcs8ArrayBuffer } from "./pem-utils";

/**
 * Subset of @clack/prompts the wizard uses. Defaults to the real module;
 * tests inject a deterministic mock.
 */
export interface WizardPrompts {
  text(opts: unknown): Promise<unknown>;
  confirm(opts: unknown): Promise<unknown>;
  note(message: string, title?: string): void;
  cancel(message: string): void;
  isCancel(value: unknown): boolean;
}

const realPrompts: WizardPrompts = {
  text: clack.text,
  confirm: clack.confirm,
  note: clack.note,
  cancel: clack.cancel,
  isCancel: clack.isCancel as (v: unknown) => boolean,
};

export interface GuidedWizardProvisionerOptions {
  /** @clack/prompts substitute (test seam). */
  prompts?: WizardPrompts;
  /**
   * GitHub API base URL. Defaults to `https://api.github.com`. Override for
   * GitHub Enterprise (e.g. `https://ghe.example.com/api/v3`).
   */
  apiBaseUrl?: string;
  /**
   * GitHub web base URL used to construct the App's HTML URL. Defaults to
   * `https://github.com`. Override for GHE (e.g. `https://ghe.example.com`).
   */
  webBaseUrl?: string;
}

export class GuidedWizardProvisioner implements AppProvisioner {
  private readonly prompts: WizardPrompts;
  private readonly apiBaseUrl: string;
  private readonly webBaseUrl: string;

  constructor(options: GuidedWizardProvisionerOptions | WizardPrompts = {}) {
    // Backwards-compat: previous callers passed a WizardPrompts directly.
    const opts: GuidedWizardProvisionerOptions =
      "text" in options && typeof (options as WizardPrompts).text === "function"
        ? { prompts: options as WizardPrompts }
        : (options as GuidedWizardProvisionerOptions);

    this.prompts = opts.prompts ?? realPrompts;
    this.apiBaseUrl = (opts.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.webBaseUrl = (opts.webBaseUrl ?? "https://github.com").replace(/\/$/, "");
  }

  async provision(spec: AppManifestSpec): Promise<AppCredentials> {
    const { text, confirm, note, isCancel, cancel } = this.prompts;
    const { name, repo, permissions, events, webhookUrl, inactive } = spec;

    note(
      [
        `You are about to create GitHub App "${name}" manually.`,
        "",
        "Steps:",
        `  1. Go to ${this.webBaseUrl}/settings/apps/new`,
        "  2. Fill in the form with these settings:",
        `       Name:        ${name}`,
        `       Homepage:    ${this.webBaseUrl}/${repo}`,
        `       Permissions: ${Object.entries(permissions)
          .map(([k, v]) => `${k}:${v}`)
          .join(", ")}`,
        events.length > 0 ? `       Events:      ${events.join(", ")}` : "",
        webhookUrl ? `       Webhook URL: ${webhookUrl}` : "",
        inactive ? "       Webhooks:    inactive" : "",
        "  3. Create the App and copy the App ID shown on the settings page.",
        "  4. Generate a private key from the App settings page.",
        "  5. Install the App on the target repo and copy the Installation ID.",
      ]
        .filter((l) => l !== "")
        .join("\n"),
      "GitHub App Setup Wizard"
    );

    // --- App ID ---
    const appIdRaw = await text({
      message: "Enter the App ID (numeric, shown on the App settings page):",
      placeholder: "e.g. 123456",
      validate: (v) => {
        if (!v || v.trim().length === 0) return "App ID is required";
        if (!/^\d+$/.test(v.trim())) return "App ID must be a number";
        return undefined;
      },
    });
    if (isCancel(appIdRaw)) {
      cancel("Setup cancelled.");
      throw new BrowserCancelledError("App creation cancelled by user");
    }
    const appId = parseInt(String(appIdRaw).trim(), 10);

    // --- Slug ---
    const slugRaw = await text({
      message: "Enter the App slug (shown in the App URL on GitHub):",
      placeholder: `e.g. ${name}`,
      validate: (v) => (!v || v.trim().length === 0 ? "Slug is required" : undefined),
    });
    if (isCancel(slugRaw)) {
      cancel("Setup cancelled.");
      throw new BrowserCancelledError("App creation cancelled by user");
    }
    const slug = String(slugRaw).trim();

    // --- Client ID ---
    const clientIdRaw = await text({
      message: "Enter the Client ID (shown on the App settings page):",
      placeholder: "e.g. Iv1.xxxxxxxxxxxxxxxx",
      validate: (v) => (!v || v.trim().length === 0 ? "Client ID is required" : undefined),
    });
    if (isCancel(clientIdRaw)) {
      cancel("Setup cancelled.");
      throw new BrowserCancelledError("App creation cancelled by user");
    }
    const clientId = String(clientIdRaw).trim();

    // --- Client Secret ---
    const clientSecretRaw = await text({
      message: "Enter the Client Secret (shown after generating on the App settings page):",
      validate: (v) => (!v || v.trim().length === 0 ? "Client Secret is required" : undefined),
    });
    if (isCancel(clientSecretRaw)) {
      cancel("Setup cancelled.");
      throw new BrowserCancelledError("App creation cancelled by user");
    }
    const clientSecret = String(clientSecretRaw).trim();

    // --- PEM ---
    note(
      "Paste the entire PEM private key below (including the -----BEGIN ... KEY----- lines).\n" +
        "Press Enter twice when done.",
      "Private Key"
    );
    const pemRaw = await text({
      message: "Paste PEM private key:",
      validate: (v) => {
        if (!v || v.trim().length === 0) return "PEM is required";
        if (
          !v.includes("-----BEGIN") ||
          (!v.includes("PRIVATE KEY-----") && !v.includes("RSA PRIVATE KEY-----"))
        ) {
          return "Does not look like a valid PEM private key";
        }
        return undefined;
      },
    });
    if (isCancel(pemRaw)) {
      cancel("Setup cancelled.");
      throw new BrowserCancelledError("App creation cancelled by user");
    }
    const pem = String(pemRaw).trim();

    // --- Validate PEM by calling /app ---
    const validating = confirm({
      message: "Validate the private key against GitHub API (/app)?",
      initialValue: true,
    });
    const shouldValidate = await validating;
    if (isCancel(shouldValidate)) {
      cancel("Setup cancelled.");
      throw new BrowserCancelledError("App creation cancelled by user");
    }

    let htmlUrl = `${this.webBaseUrl}/apps/${slug}`;

    if (shouldValidate) {
      try {
        const jwt = await buildJwt(appId, pem);
        const resp = await fetch(`${this.apiBaseUrl}/app`, {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "User-Agent": `${name}-setup`,
          },
        });
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`GitHub API rejected the credentials: ${errText}`);
        }
        const appInfo = (await resp.json()) as { html_url?: string };
        if (appInfo.html_url) htmlUrl = appInfo.html_url;
        note("Private key validated successfully.", "Validation");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`PEM validation failed: ${msg}`);
      }
    }

    // --- Installation ID (optional) ---
    const installIdRaw = await text({
      message: "Enter the Installation ID (optional — leave blank if not yet installed):",
      placeholder: "e.g. 98765432",
      validate: (v) => {
        if (!v || v.trim().length === 0) return undefined; // optional
        if (!/^\d+$/.test(v.trim())) return "Installation ID must be a number";
        return undefined;
      },
    });
    if (isCancel(installIdRaw)) {
      cancel("Setup cancelled.");
      throw new BrowserCancelledError("App creation cancelled by user");
    }
    const installationId =
      installIdRaw && String(installIdRaw).trim().length > 0
        ? parseInt(String(installIdRaw).trim(), 10)
        : undefined;

    return {
      appId,
      slug,
      clientId,
      clientSecret,
      pem,
      htmlUrl,
      installationId,
    };
  }
}

async function buildJwt(appId: number, pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/=/g, "");
  const payload = btoa(
    JSON.stringify({ iat: now - 60, exp: now + 300, iss: String(appId) })
  ).replace(/=/g, "");
  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8ArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const bytes = new Uint8Array(sig);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const b64u = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `${signingInput}.${b64u}`;
}
