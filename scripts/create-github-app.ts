#!/usr/bin/env bun
/**
 * Create a GitHub App via the manifest flow.
 *
 * **The canonical user-facing path is `minsky setup github-app`** (mt#1087);
 * this script is retained as a thin shim for fresh checkouts that don't yet
 * have the CLI installed and for the existing docs invocations.
 *
 * Flag surface is preserved for backwards compatibility:
 *
 *   bun scripts/create-github-app.ts \
 *     --name minsky-reviewer \
 *     --repo edobry/minsky \
 *     --permissions pull_requests:write,contents:read,metadata:read \
 *     --events pull_request \
 *     --webhook-url https://minsky-reviewer.example.com/webhook
 *
 * Writes credentials to `~/.config/minsky/<name>.{pem,json}`.
 *
 * @see mt#997 — original parametrized script (now lifted into the domain layer)
 * @see mt#1087 — `minsky setup github-app` shared command + provisioner/store split
 */

import { homedir } from "os";
import { join } from "path";
import {
  LocalConfigCredentialStore,
  ManifestFlowProvisioner,
  provisionGithubApp,
  type AppManifestSpec,
} from "@minsky/domain/setup/github-app";

interface ParsedArgs {
  name: string;
  repo: string;
  owner: string;
  permissions: Record<string, string>;
  events: string[];
  port: number;
  webhookUrl?: string;
  inactive: boolean;
  force: boolean;
}

function printUsage(): void {
  const usage = `
Create a GitHub App via the manifest flow.

Recommended:
  minsky setup github-app --name <name> --repo <owner>/<repo> [options]

This script (legacy invocation, same flag surface):
  bun scripts/create-github-app.ts --name <name> --repo <owner>/<repo> [options]

Required:
  --name <name>             App name (also file prefix under ~/.config/minsky/)
  --repo <owner>/<repo>     Repo to install on (e.g., edobry/minsky)

Optional:
  --permissions k:v,k:v     Default: pull_requests:write,contents:read,metadata:read
  --events e1,e2            Default: (none)
  --webhook-url <url>       Prefill the App webhook URL. Default: placeholder.
  --inactive                Create the App with webhooks disabled. Default: active.
  --port <n>                Default: 9847
  --force                   Re-provision even if credentials already exist.
  --help / -h               Print this usage.
`.trim();
  console.log(usage);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const BOOLEAN_FLAGS = new Set(["inactive", "force"]);

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

  return {
    name,
    repo,
    owner: repoParts[0],
    permissions,
    events,
    port,
    webhookUrl: map.get("webhook-url"),
    inactive: map.get("inactive") === "true",
    force: map.get("force") === "true",
  };
}

const args = parseArgs(process.argv);

const spec: AppManifestSpec = {
  name: args.name,
  repo: args.repo,
  owner: args.owner,
  permissions: args.permissions,
  events: args.events,
  webhookUrl: args.webhookUrl,
  inactive: args.inactive,
};

const outputDir = join(homedir(), ".config", "minsky");
const store = new LocalConfigCredentialStore(outputDir);
const provisioner = new ManifestFlowProvisioner({ port: args.port });

console.log(`Provisioning GitHub App: ${args.name} for repo ${args.repo}`);

// Whether the manifest-flow server actually starts depends on whether
// credentials already exist (orchestrator short-circuits in that case).
// Only print the localhost URL when we know a server will actually run.
const willStartServer = args.force || !(await store.exists(args.name));
if (willStartServer) {
  console.log(`Local callback listener at http://localhost:${args.port}`);
  console.log(
    `If the browser does not open automatically, visit http://localhost:${args.port}.\n` +
      `If the App is created but not yet installed, finish installation in the browser, then\n` +
      `return and visit http://localhost:${args.port}/check-install to capture the installation ID.\n`
  );
}

try {
  const result = await provisionGithubApp({
    name: args.name,
    spec,
    store,
    provisioner,
    force: args.force,
  });

  if (result.status === "already-exists") {
    console.log(`\nApp "${args.name}" already exists. Pass --force to re-create.`);
    console.log(
      JSON.stringify(
        {
          appId: result.credentials.appId,
          installationId: result.credentials.installationId,
          privateKeyFile: join(outputDir, `${args.name}.pem`),
        },
        null,
        2
      )
    );
  } else {
    console.log(`\nApp created! ID: ${result.credentials.appId}, slug: ${result.credentials.slug}`);
    if (result.credentials.installationId) {
      console.log(`Installation ID: ${result.credentials.installationId}`);
    }
    console.log(`Private key: ${join(outputDir, `${args.name}.pem`)}`);
  }
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\nApp creation failed: ${msg}`);
  process.exit(1);
}
