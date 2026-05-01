/**
 * ManifestFlowProvisioner — provisions a GitHub App via the browser-based
 * manifest flow. Starts a local HTTP server, opens the browser, waits for the
 * OAuth callback, then exchanges the code for credentials.
 *
 * Rejects with BrowserCancelledError if the deadline elapses without a callback.
 * Always shuts the server down on both success and timeout.
 *
 * @see mt#1087
 */

import { serve } from "bun";
import type { AppProvisioner } from "./provisioner";
import { BrowserCancelledError } from "./provisioner";
import type { AppManifestSpec, AppCredentials } from "./types";
import { pemToPkcs8ArrayBuffer } from "./pem-utils";

/** Default timeout: 5 minutes */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ManifestFlowProvisionerOptions {
  /** Milliseconds to wait for the browser callback before giving up. */
  timeoutMs?: number;
  /** Port to listen on. Pass 0 to let the OS pick a free port. */
  port?: number;
}

export class ManifestFlowProvisioner implements AppProvisioner {
  private readonly timeoutMs: number;
  private readonly port: number;

  constructor(options: ManifestFlowProvisionerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.port = options.port ?? 9847;
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

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        server.stop(true);
        reject(
          new BrowserCancelledError("App creation not approved in browser; nothing was saved")
        );
      }, this.timeoutMs);

      const server = serve({
        port: this.port,
        async fetch(req) {
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
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  server.stop(true);
                  reject(new Error(`GitHub API error during manifest conversion: ${err}`));
                }
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

              // Attempt to look up the installation ID
              let installationId: number | undefined;
              try {
                installationId = await lookupInstallationId(app.id, app.pem, owner, name);
              } catch {
                // Non-fatal — caller can look it up later
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

              if (!settled) {
                settled = true;
                clearTimeout(timer);
                // Give the browser a nice response before stopping
                const responseHtml = `<!DOCTYPE html><html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px">
<h1>Done!</h1>
<p><b>App ID:</b> ${app.id}</p>
${installationId ? `<p><b>Installation ID:</b> ${installationId}</p>` : ""}
<p>You can close this tab. Everything has been saved.</p>
</body></html>`;
                setTimeout(() => server.stop(true), 2000);
                resolve(creds);
                return new Response(responseHtml, {
                  headers: { "Content-Type": "text/html" },
                });
              }
            } catch (err) {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                server.stop(true);
                reject(err instanceof Error ? err : new Error(String(err)));
              }
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
