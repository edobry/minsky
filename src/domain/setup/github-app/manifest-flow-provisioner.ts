/**
 * ManifestFlowProvisioner — provisions a GitHub App via the browser-based
 * manifest flow. Starts a local HTTP server, opens the browser, waits for the
 * OAuth callback, then exchanges the code for credentials.
 *
 * Two-phase flow:
 *   1. /callback receives GitHub's redirect after the user clicks "Create",
 *      converts the code to credentials, and tries to look up the installation
 *      ID (in case the App is already installed).
 *   2. If the installation lookup succeeds, we resolve immediately and stop
 *      the server. If it does NOT succeed (the App was just created and the
 *      user has not yet installed it on the repo), we keep the server alive
 *      and serve a /check-install endpoint. The browser shows an "Install
 *      App" link; the user clicks it, completes installation on GitHub, then
 *      returns to /check-install which polls /app/installations and resolves.
 *
 * Rejects with BrowserCancelledError if the deadline elapses without
 * a fully-installed App. Always shuts the server down on resolve, reject,
 * or timeout.
 *
 * @see mt#1087
 * @see mt#997 — original /check-install behavior in scripts/create-github-app.ts
 */

import { serve } from "bun";
import type { AppProvisioner } from "./provisioner";
import { BrowserCancelledError } from "./provisioner";
import type { AppManifestSpec, AppCredentials } from "./types";
import { pemToPkcs8ArrayBuffer } from "./pem-utils";

/** Default timeout: 5 minutes */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Look up an App's installation ID for a given owner. Default builds an
 * RS256 JWT and queries `/app/installations`; tests can inject a stub that
 * skips the WebCrypto path (which requires a real PKCS#8/PKCS#1 PEM).
 */
export type InstallationLookup = (
  appId: number,
  pem: string,
  owner: string,
  appName: string
) => Promise<number | undefined>;

export interface ManifestFlowProvisionerOptions {
  /** Milliseconds to wait for the browser callback before giving up. */
  timeoutMs?: number;
  /** Port to listen on. Pass 0 to let the OS pick a free port. */
  port?: number;
  /** Override the installation-lookup strategy (test seam). */
  installationLookup?: InstallationLookup;
}

export class ManifestFlowProvisioner implements AppProvisioner {
  private readonly timeoutMs: number;
  private readonly port: number;
  private readonly installationLookup: InstallationLookup;

  constructor(options: ManifestFlowProvisionerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.port = options.port ?? 9847;
    this.installationLookup = options.installationLookup ?? lookupInstallationId;
  }

  async provision(spec: AppManifestSpec): Promise<AppCredentials> {
    const { name, repo, owner, permissions, events, webhookUrl, inactive } = spec;

    const manifest = {
      name,
      url: `https://github.com/${repo}`,
      hook_attributes: {
        url: webhookUrl ?? "https://example.com/unused",
        active: !inactive,
      },
      redirect_url: `http://localhost:${this.port}/callback`,
      public: false,
      default_permissions: permissions,
      default_events: events,
    };

    const manifestJson = JSON.stringify(manifest);
    const manifestHtmlSafe = manifestJson
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const html = `<!DOCTYPE html>
<html>
<head><title>Create ${name} GitHub App</title></head>
<body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px">
<h1>Create ${name} GitHub App</h1>
<p>Target repo: <code>${repo}</code></p>
<p>Click to create the App. GitHub will confirm, then redirect back automatically.</p>
<form action="https://github.com/settings/apps/new" method="post">
<input type="hidden" name="manifest" value="${manifestHtmlSafe}">
<button type="submit" style="padding:12px 24px;font-size:16px;background:#238636;color:#fff;border:none;border-radius:6px;cursor:pointer">Create GitHub App</button>
</form>
</body></html>`;

    return new Promise<AppCredentials>((resolve, reject) => {
      let settled = false;
      // After /callback succeeds we have App credentials but may not yet have
      // an installationId. Stash them here so /check-install can pick up where
      // /callback left off.
      let pendingApp: AppCredentials | null = null;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        server.stop(true);
        // Two failure modes share the same deadline: (a) user never approved
        // the manifest at all, (b) user approved + we got creds but never
        // came back to /check-install. In case (b) we still reject with
        // BrowserCancelledError because the App is not fully installed.
        const msg = pendingApp
          ? "App was created but not installed in time; nothing was saved"
          : "App creation not approved in browser; nothing was saved";
        reject(new BrowserCancelledError(msg));
      }, this.timeoutMs);

      const settle = (creds: AppCredentials, port: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Brief delay so the browser receives its response before the socket dies.
        setTimeout(() => server.stop(true), 2000);
        // `port` is captured for /check-install message reconstruction; not used here
        void port;
        resolve(creds);
      };

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.stop(true);
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const server = serve({
        port: this.port,
        fetch: async (req) => {
          const url = new URL(req.url);

          if (url.pathname === "/" && !settled) {
            return new Response(html, {
              headers: { "Content-Type": "text/html" },
            });
          }

          if (url.pathname === "/callback") {
            const code = url.searchParams.get("code");
            if (!code) {
              return new Response("No code in redirect. Check the URL for errors.", {
                status: 400,
              });
            }

            try {
              const resp = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
                method: "POST",
                headers: {
                  Accept: "application/vnd.github+json",
                  "User-Agent": `${name}-setup`,
                },
              });

              if (!resp.ok) {
                const err = await resp.text();
                fail(new Error(`GitHub API error during manifest conversion: ${err}`));
                return new Response(`GitHub API error: ${err}`, { status: 500 });
              }

              const app = (await resp.json()) as {
                id: number;
                slug: string;
                pem: string;
                client_id: string;
                client_secret: string;
                html_url: string;
              };

              // Attempt to look up the installation ID immediately. Apps just
              // created via manifest are usually NOT yet installed; this path
              // covers the rare case where the user pre-installed and we get
              // lucky.
              let installationId: number | undefined;
              try {
                installationId = await this.installationLookup(app.id, app.pem, owner, name);
              } catch {
                // Non-fatal — fall through to the /check-install path below
              }

              const creds: AppCredentials = {
                appId: app.id,
                slug: app.slug,
                clientId: app.client_id,
                clientSecret: app.client_secret,
                pem: app.pem,
                htmlUrl: app.html_url,
                installationId,
              };

              if (installationId !== undefined) {
                // Happy path: App created AND already installed.
                settle(creds, this.port);
                const okHtml = `<!DOCTYPE html><html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px">
<h1>Done!</h1>
<p><b>App ID:</b> ${app.id}</p>
<p><b>Installation ID:</b> ${installationId}</p>
<p>You can close this tab. Everything has been saved.</p>
</body></html>`;
                return new Response(okHtml, {
                  headers: { "Content-Type": "text/html" },
                });
              }

              // App created but not yet installed. Stash creds, present the
              // install link + /check-install round-trip, keep server alive.
              pendingApp = creds;
              const installUrl = `${app.html_url}/installations/new`;
              const checkUrl = `http://localhost:${this.port}/check-install`;
              const partialHtml = `<!DOCTYPE html><html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px">
<h1>App Created!</h1>
<p><b>App ID:</b> ${app.id}</p>
<p>Now install it on <code>${repo}</code>:</p>
<a href="${installUrl}" style="display:inline-block;padding:12px 24px;font-size:16px;background:#238636;color:#fff;text-decoration:none;border-radius:6px">Install App</a>
<p style="margin-top:20px;color:#666">After installing, return to this tab and visit <a href="${checkUrl}">${checkUrl}</a> to finish setup.</p>
</body></html>`;
              return new Response(partialHtml, {
                headers: { "Content-Type": "text/html" },
              });
            } catch (err) {
              fail(err);
              return new Response("Internal error", { status: 500 });
            }
          }

          if (url.pathname === "/check-install" && pendingApp && !settled) {
            try {
              const installationId = await this.installationLookup(
                pendingApp.appId,
                pendingApp.pem,
                owner,
                name
              );
              if (installationId === undefined) {
                return new Response(
                  `Installation not found yet. Make sure you installed the App on ${repo}, then refresh this page.`,
                  { status: 404 }
                );
              }
              const completed: AppCredentials = { ...pendingApp, installationId };
              settle(completed, this.port);
              const doneHtml = `<!DOCTYPE html><html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px">
<h1>All Done!</h1>
<p><b>App ID:</b> ${pendingApp.appId}</p>
<p><b>Installation ID:</b> ${installationId}</p>
<p>You can close this tab.</p></body></html>`;
              return new Response(doneHtml, {
                headers: { "Content-Type": "text/html" },
              });
            } catch (err) {
              fail(err);
              return new Response("Internal error", { status: 500 });
            }
          }

          return new Response("Not found", { status: 404 });
        },
      });

      // Best-effort browser open
      const openCmd =
        process.platform === "darwin"
          ? ["open", `http://localhost:${this.port}`]
          : process.platform === "win32"
            ? ["cmd", "/c", "start", `http://localhost:${this.port}`]
            : ["xdg-open", `http://localhost:${this.port}`];
      try {
        Bun.spawn(openCmd);
      } catch {
        // Fire-and-forget
      }
    });
  }
}

/** Build a short-lived JWT and fetch /app/installations to find the target owner. */
async function lookupInstallationId(
  appId: number,
  pem: string,
  owner: string,
  appName: string
): Promise<number | undefined> {
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
  const jwt = `${signingInput}.${arrayBufferToBase64Url(sig)}`;

  const resp = await fetch("https://api.github.com/app/installations", {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": `${appName}-setup`,
    },
  });

  if (!resp.ok) return undefined;

  const installations = (await resp.json()) as Array<{
    id: number;
    account: { login: string };
  }>;
  const inst = installations.find((i) => i.account.login === owner);
  return inst?.id;
}

function arrayBufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
