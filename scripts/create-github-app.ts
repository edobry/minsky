#!/usr/bin/env bun
/**
 * Create a GitHub App via the manifest flow.
 *
 * Starts a local HTTP server, opens a browser to GitHub's "Create App from
 * manifest" page, captures the redirect, exchanges the code for credentials,
 * and saves them to `~/.config/minsky/<name>.pem` and `<name>.json`. Also
 * attempts to look up and save the installation ID after the user installs
 * the App on the target repo.
 *
 * Works for any GitHub App — originally written for `minsky-ai` (the
 * implementer identity) and later parametrized for `minsky-reviewer` (the
 * Chinese-wall reviewer identity). Run it once per App you need.
 *
 * Usage:
 *
 *   bun scripts/create-github-app.ts \
 *     --name minsky-reviewer \
 *     --repo edobry/minsky \
 *     --permissions pull_requests:write,contents:read,metadata:read \
 *     --events pull_request
 *
 *   bun scripts/create-github-app.ts \
 *     --name minsky-ai \
 *     --repo edobry/minsky \
 *     --permissions pull_requests:write,contents:read,metadata:read
 *
 * The script writes:
 *   ~/.config/minsky/<name>.pem   (private key, 0600)
 *   ~/.config/minsky/<name>.json  (appId, slug, clientId, installationId, ...)
 *
 * Flags:
 *   --name <name>           Required. Also used as file prefix under ~/.config/minsky/.
 *   --repo <owner/name>     Required. Owner is matched against the install account during lookup.
 *   --permissions k:v,...   Optional. Default: pull_requests:write,contents:read,metadata:read.
 *   --events e1,e2,...      Optional. Default: (none for permissions-only Apps).
 *   --port <n>              Optional. Default: 9847.
 *   --help / -h             Print this usage.
 *
 * @see mt#997 — Preserve /tmp/create-github-app.ts helper script
 * @see mt#1087 — Fold App creation into minsky setup/init flow (follow-up)
 */

import { serve } from "bun";
import { writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Arg parsing (inline, zero-dep so the script runs from fresh checkouts)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  name: string;
  repo: string;
  owner: string;
  permissions: Record<string, string>;
  events: string[];
  port: number;
  webhookUrl?: string;
  inactive: boolean;
}

function printUsage(): void {
  const usage = `
Create a GitHub App via the manifest flow.

Usage:
  bun scripts/create-github-app.ts --name <name> --repo <owner/repo> [options]

Required:
  --name <name>             App name (also file prefix under ~/.config/minsky/)
  --repo <owner/repo>       Repo to install on (e.g., edobry/minsky)

Optional:
  --permissions k:v,k:v     Default: pull_requests:write,contents:read,metadata:read
  --events e1,e2            Default: (none)
  --webhook-url <url>       Prefill the App webhook URL. Default: placeholder.
  --inactive                Create the App with webhooks disabled. Default: active.
  --port <n>                Default: 9847
  --help / -h               Print this usage

Examples:

  # Implementer App (code author, PR creator; no webhook needed):
  bun scripts/create-github-app.ts \\
    --name minsky-ai \\
    --repo edobry/minsky \\
    --inactive

  # Reviewer App (Chinese-wall adversarial reviewer, webhook-driven):
  bun scripts/create-github-app.ts \\
    --name minsky-reviewer \\
    --repo edobry/minsky \\
    --permissions pull_requests:write,contents:read,metadata:read \\
    --events pull_request \\
    --webhook-url https://minsky-reviewer.example.com/webhook
`.trim();
  console.log(usage);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const BOOLEAN_FLAGS = new Set(["inactive"]);

  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        map.set(key, "true");
        continue;
      }
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        console.error(`Missing value for --${key}`);
        printUsage();
        process.exit(1);
      }
      map.set(key, value);
      i++;
    }
  }

  const name = map.get("name");
  const repo = map.get("repo");
  if (!name || !repo) {
    console.error("--name and --repo are required.");
    printUsage();
    process.exit(1);
  }

  const repoParts = repo.split("/");
  if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
    console.error(`--repo must be <owner>/<name>, got "${repo}"`);
    process.exit(1);
  }

  const permsRaw = map.get("permissions") ?? "pull_requests:write,contents:read,metadata:read";
  const permissions: Record<string, string> = {};
  for (const entry of permsRaw.split(",")) {
    const [k, v] = entry.split(":");
    if (!k || !v) {
      console.error(`Malformed --permissions entry: "${entry}". Expected k:v.`);
      process.exit(1);
    }
    permissions[k.trim()] = v.trim();
  }

  const eventsRaw = map.get("events") ?? "";
  const events = eventsRaw
    ? eventsRaw
        .split(",")
        .map((e) => e.trim())
        .filter((e) => e.length > 0)
    : [];

  const portRaw = map.get("port") ?? "9847";
  const port = parseInt(portRaw, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error(`--port must be a valid TCP port, got "${portRaw}"`);
    process.exit(1);
  }

  const webhookUrl = map.get("webhook-url");
  const inactive = map.get("inactive") === "true";

  return {
    name,
    repo,
    owner: repoParts[0],
    permissions,
    events,
    port,
    webhookUrl,
    inactive,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const parsed = parseArgs(process.argv);
const { name, repo, owner, permissions, events, port, webhookUrl, inactive } = parsed;

const HOME = process.env.HOME;
if (!HOME) {
  console.error("HOME environment variable is not set; cannot determine config directory.");
  process.exit(1);
}

const CONFIG_DIR = join(HOME, ".config", "minsky");
const KEY_PATH = join(CONFIG_DIR, `${name}.pem`);
const META_PATH = join(CONFIG_DIR, `${name}.json`);

// Manifest per GitHub docs — hook_attributes.url is REQUIRED even when webhooks
// are inactive, so we provide a placeholder if --webhook-url wasn't given.
const manifest = {
  name,
  url: `https://github.com/${repo}`,
  hook_attributes: {
    url: webhookUrl ?? "https://example.com/unused",
    active: !inactive,
  },
  redirect_url: `http://localhost:${port}/callback`,
  public: false,
  default_permissions: permissions,
  default_events: events,
};

const manifestJson = JSON.stringify(manifest);
// HTML attribute encoding: escape &, ", <, > so user-supplied values
// (webhook URL with query-string, arbitrary name/repo strings) don't
// break the form's HTML structure. Ampersand MUST be replaced first
// so later replacements don't re-escape their introduced &.
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

let appCreated = false;

const server = serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" && !appCreated) {
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response("No code in redirect. Check the URL for errors.", { status: 400 });
      }

      console.log("Got code from GitHub, exchanging for credentials...");

      const resp = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: "POST",
        headers: { Accept: "application/vnd.github+json", "User-Agent": `${name}-setup` },
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error("API error:", err);
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

      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(KEY_PATH, app.pem);
      chmodSync(KEY_PATH, 0o600);
      writeFileSync(
        META_PATH,
        JSON.stringify(
          {
            appId: app.id,
            slug: app.slug,
            clientId: app.client_id,
            privateKeyFile: KEY_PATH,
            createdAt: new Date().toISOString(),
          },
          null,
          2
        )
      );

      appCreated = true;
      console.log(`\nApp created! ID: ${app.id}, slug: ${app.slug}`);
      console.log(`Private key: ${KEY_PATH}`);
      console.log(`Metadata: ${META_PATH}`);
      console.log(`\nNow fetching installation ID...`);

      // Generate a short-lived JWT to list installations and find the target repo's install.
      const privateKey = await Bun.file(KEY_PATH).text();
      const now = Math.floor(Date.now() / 1000);
      const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/=/g, "");
      const payload = btoa(
        JSON.stringify({ iat: now - 60, exp: now + 300, iss: String(app.id) })
      ).replace(/=/g, "");
      const signingInput = `${header}.${payload}`;

      const key = await crypto.subtle.importKey(
        "pkcs8",
        pemToArrayBuffer(privateKey),
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

      const instResp = await fetch("https://api.github.com/app/installations", {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": `${name}-setup`,
        },
      });

      let installationId: number | null = null;
      const installUrl = `${app.html_url}/installations/new`;

      if (instResp.ok) {
        const installations = (await instResp.json()) as Array<{
          id: number;
          account: { login: string };
        }>;
        const inst = installations.find((i) => i.account.login === owner);
        if (inst) {
          installationId = inst.id;
          console.log(`Installation ID: ${installationId}`);
          const meta = JSON.parse(await Bun.file(META_PATH).text());
          meta.installationId = installationId;
          writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
        }
      }

      if (installationId) {
        console.log("\nAll done! App is created and installed.");
        console.log(
          JSON.stringify({ appId: app.id, installationId, privateKeyFile: KEY_PATH }, null, 2)
        );
        setTimeout(() => {
          server.stop();
          process.exit(0);
        }, 3000);
        return new Response(
          `<!DOCTYPE html><html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px">
<h1>Done!</h1>
<p><b>App ID:</b> ${app.id}</p>
<p><b>Installation ID:</b> ${installationId}</p>
<p><b>Private key:</b> <code>${KEY_PATH}</code></p>
<p>You can close this tab. Everything has been saved.</p>
</body></html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      } else {
        console.log("\nApp created but not yet installed. Install it now:");
        console.log(installUrl);
        return new Response(
          `<!DOCTYPE html><html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px">
<h1>App Created!</h1>
<p><b>App ID:</b> ${app.id}</p>
<p>Now install it on <code>${repo}</code>:</p>
<a href="${installUrl}" style="display:inline-block;padding:12px 24px;font-size:16px;background:#238636;color:#fff;text-decoration:none;border-radius:6px">Install App</a>
<p style="margin-top:20px;color:#666">After installing, visit <a href="http://localhost:${port}/check-install">this link</a> to verify.</p>
</body></html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }
    }

    if (url.pathname === "/check-install" && appCreated) {
      const meta = JSON.parse(await Bun.file(META_PATH).text());
      const privateKey = await Bun.file(KEY_PATH).text();
      const now = Math.floor(Date.now() / 1000);
      const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/=/g, "");
      const payload = btoa(
        JSON.stringify({ iat: now - 60, exp: now + 300, iss: String(meta.appId) })
      ).replace(/=/g, "");
      const signingInput = `${header}.${payload}`;
      const key = await crypto.subtle.importKey(
        "pkcs8",
        pemToArrayBuffer(privateKey),
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

      const instResp = await fetch("https://api.github.com/app/installations", {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": `${name}-setup`,
        },
      });

      if (instResp.ok) {
        const installations = (await instResp.json()) as Array<{
          id: number;
          account: { login: string };
        }>;
        const inst = installations.find((i) => i.account.login === owner);
        if (inst) {
          meta.installationId = inst.id;
          writeFileSync(META_PATH, JSON.stringify(meta, null, 2));
          console.log(`\nInstallation ID found: ${inst.id}`);
          console.log(JSON.stringify(meta, null, 2));
          setTimeout(() => {
            server.stop();
            process.exit(0);
          }, 3000);
          return new Response(
            `<!DOCTYPE html><html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px">
<h1>All Done!</h1>
<p><b>App ID:</b> ${meta.appId}</p>
<p><b>Installation ID:</b> ${inst.id}</p>
<p><b>Private key:</b> <code>${KEY_PATH}</code></p>
<p>You can close this tab.</p></body></html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }
      }
      return new Response(
        `Installation not found yet. Make sure you installed the app on ${repo}, then refresh.`,
        { status: 404 }
      );
    }

    return new Response("Not found", { status: 404 });
  },
});

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

function arrayBufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

console.log(`Server running at http://localhost:${port}`);
console.log(`Creating App: ${name} for repo ${repo}`);
console.log(`\nIf the browser does not open automatically, visit: http://localhost:${port}\n`);

// Cross-platform browser open: macOS uses `open`, Linux uses `xdg-open`, Windows uses `start`.
const openCmd =
  process.platform === "darwin"
    ? ["open", `http://localhost:${port}`]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", `http://localhost:${port}`]
      : ["xdg-open", `http://localhost:${port}`];
try {
  Bun.spawn(openCmd);
} catch {
  // Fire-and-forget; if spawn fails the user still sees the URL above.
}
