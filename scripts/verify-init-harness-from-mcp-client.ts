#!/usr/bin/env bun
/**
 * Live verification for mt#5153 AT2 / mt#4510 AT2: over MCP, `init` records the
 * harness from the CALLER's identity, not from the daemon's environment.
 *
 * Why a script rather than a unit test: the claim is about what the daemon
 * DOES with a real `initialize` handshake — ADR-006 Layer 1 derives the agent
 * kind from `clientInfo.name`, `src/mcp/server.ts` injects the resolved id as
 * `callerActorId` for the `init` tool, and `resolveInitClient` maps it. A unit
 * test pins each link; only a real client against a real daemon exercises the
 * chain, and the daemon on a developer's machine is the wrong instrument: the
 * one serving on 2026-09-14 was spawned by a cockpit tray relaunched out of an
 * agent's Bash and carried `CLAUDECODE=1`, so any client would have read as
 * Claude Code through it. This script therefore expects a daemon YOU started
 * with every harness variable unset (see Usage), and presents three clients:
 *
 *   - `clientInfo.name: "claude-code"` → expects `harness: claude-code`,
 *     `harnessSource: mcp-client`
 *   - `clientInfo.name: "cursor"`      → expects `harness: cursor`,
 *     `harnessSource: mcp-client` (the negative control — same daemon, same
 *     environment, different answer)
 *   - an unrecognised name             → expects a REFUSAL naming `client`,
 *     not a guess (on a machine with ≥2 clients installed)
 *
 * Usage (from the repo root; port is arbitrary and unused elsewhere):
 *
 *   env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID \
 *       -u CLAUDE_CODE_EXECPATH -u CLAUDE_PROJECT_DIR -u CLAUDE_CODE \
 *       -u CLAUDE_CODE_SUBAGENT_MODEL -u VSCODE_PID -u CURSOR_SESSION_ID \
 *       -u CURSOR_TRACE_ID \
 *     bun src/cli.ts mcp start --http --host=127.0.0.1 --port=48799 &
 *   bun scripts/verify-init-harness-from-mcp-client.ts --url http://127.0.0.1:48799/mcp
 *
 * Auth: the daemon requires the local bearer token (ADR-038 §Question 5). The
 * script attaches `MINSKY_MCP_AUTH_TOKEN` when set, else the token file at
 * `~/.config/minsky/local-mcp-token` (or `--token-path <file>`), exactly as the
 * shim does; the value is never printed.
 *
 * Writes only under a fresh temp directory it creates and removes. Note that a
 * `claude-code` resolution registers Minsky at Claude Code's USER scope
 * (`~/.claude.json`, mt#4676) exactly as a real `init` would — idempotent when
 * the entry already exists. Exit 0 = every expectation held; 1 = a mismatch,
 * printed; 2 = the daemon was not reachable or the run itself failed.
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { parse as yamlParse } from "yaml";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { safeTruncate } from "../src/utils/safe-truncate";

interface Expectation {
  clientName: string;
  expect: { harness: string; source: string } | { refusalNames: string };
}

const CASES: Expectation[] = [
  { clientName: "claude-code", expect: { harness: "claude-code", source: "mcp-client" } },
  { clientName: "cursor", expect: { harness: "cursor", source: "mcp-client" } },
  { clientName: "some-unknown-editor", expect: { refusalNames: "client" } },
];

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function resolveBearerToken(): string | undefined {
  // An explicit `--token-path` wins over the environment: a shell spawned by
  // the LOCAL daemon inherits that daemon's `MINSKY_MCP_AUTH_TOKEN`, which is
  // the wrong token for the scratch daemon this script is pointed at.
  const explicitPath = argValue("--token-path");
  const fromEnv = process.env.MINSKY_MCP_AUTH_TOKEN?.trim();
  if (explicitPath === undefined && fromEnv) return fromEnv;
  const tokenPath = explicitPath ?? join(homedir(), ".config", "minsky", "local-mcp-token");
  try {
    const raw = readFileSync(tokenPath, "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    // intentional-swallow: no token file means "try unauthenticated"; a 401 then says so.
    return undefined;
  }
}

async function callInit(url: string, clientName: string, repo: string): Promise<string> {
  const client = new Client({ name: clientName, version: "0.0.0-verify" });
  const token = resolveBearerToken();
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "init",
      arguments: { repo, backend: "minsky", mcp: "true" },
    });
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    return content.map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
  }
}

async function main(): Promise<number> {
  const url = argValue("--url") ?? "http://127.0.0.1:48799/mcp";
  const health = await fetch(url.replace(/\/mcp$/, "/health"), {
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  if (!health || !health.ok) {
    console.error(`FAIL(2): no daemon answering at ${url} — start one per the Usage block.`);
    return 2;
  }

  let failures = 0;
  const base = mkdtempSync(join(tmpdir(), "mt5153-at2-"));
  try {
    for (const c of CASES) {
      const repo = join(base, c.clientName);
      // A refusal reaches an MCP client as a tool ERROR (the command throws a
      // ValidationError), so the error text is the artifact to score, not a
      // failure of the run.
      const text = await callInit(url, c.clientName, repo).catch((error: unknown) =>
        error instanceof Error ? `ERROR: ${error.message}` : `ERROR: ${String(error)}`
      );
      const localConfig = join(repo, ".minsky", "config.local.yaml");
      const workspace = existsSync(localConfig)
        ? ((yamlParse(readFileSync(localConfig, "utf8")) as { workspace?: Record<string, unknown> })
            .workspace ?? {})
        : undefined;

      if ("refusalNames" in c.expect) {
        const refused = workspace === undefined && text.includes(c.expect.refusalNames);
        console.log(
          `${refused ? "ok  " : "FAIL"} clientInfo.name=${c.clientName}: ${
            refused
              ? `refused, naming \`${c.expect.refusalNames}\`; nothing written — ${safeTruncate(
                  text.replace(/^ERROR: /, ""),
                  220,
                  "head"
                )}`
              : `expected a refusal naming \`${c.expect.refusalNames}\` and no write; got ` +
                `${workspace ? JSON.stringify(workspace) : "no file"} / ${safeTruncate(text, 200, "head")}`
          }`
        );
        if (!refused) failures += 1;
        continue;
      }

      const got = { harness: workspace?.harness, source: workspace?.harnessSource };
      const ok = got.harness === c.expect.harness && got.source === c.expect.source;
      console.log(
        `${ok ? "ok  " : "FAIL"} clientInfo.name=${c.clientName}: harness=${String(got.harness)} ` +
          `harnessSource=${String(got.source)}${
            ok
              ? ""
              : ` (expected ${c.expect.harness} / ${c.expect.source}; result text: ${safeTruncate(text, 200, "head")})`
          }`
      );
      if (!ok) failures += 1;
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ cases: CASES.length, failures }));
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`FAIL(2): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
);
