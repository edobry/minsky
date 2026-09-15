#!/usr/bin/env bun
/**
 * Live verification for mt#5155: a daemon started from project A answers a
 * tool call that names project B with B's rows and B's config.
 *
 * Runs against a daemon you start yourself — from the MINSKY checkout (project
 * A), so its cwd is the wrong project for every call below — and exercises:
 *
 *   AT1  config_show --workspace B --sources → B's project source + mainPath
 *   AT2  tasks_list --workspace B → B's scope (projectId), includes --task;
 *        tasks_list with no argument → the daemon's cwd scope (control);
 *        tasks_list --workspace <dir with no project> → unresolved, 0 rows
 *   AT3  session_list --repo <slug> / --repo B → B's scope;
 *        session_list --repo nonexistent/repo → unresolved with a reason
 *   AT5  tasks_get taskId --workspace B, then tasks_claims_list → the presence
 *        claim carries B's projectId (server.ts resolveProjectIdBestEffort)
 *
 * Usage:
 *   bun run build
 *   MINSKY_MCP_AUTH_TOKEN=$(cat <token-file>) bun run dist/minsky.js mcp start --http \
 *     --host=127.0.0.1 --port=48799     # from the minsky checkout
 *   bun scripts/verify-read-scope-from-workspace.ts \
 *     --url http://127.0.0.1:48799/mcp --token-path <token-file> \
 *     --workspace /path/to/projectB --slug owner/projectB --task mt#NNNN \
 *     --expect-project-id <projectB uuid>
 *
 * Emits: per-check PASS/FAIL lines and the fields each assertion read. Never
 * prints the bearer token. Exit 0 = every check passed; 1 = a check failed;
 * 2 = no daemon answered.
 */

import { mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { safeTruncate } from "../src/utils/safe-truncate";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function resolveBearerToken(): string | undefined {
  // An explicit `--token-path` wins over the environment (mem#1392): a shell
  // spawned by the LOCAL daemon inherits that daemon's token, which is the
  // wrong one for the scratch daemon this script is pointed at.
  const explicitPath = argValue("--token-path");
  const fromEnv = process.env.MINSKY_MCP_AUTH_TOKEN?.trim();
  if (!explicitPath && fromEnv) return fromEnv;
  const tokenPath = explicitPath ?? join(homedir(), ".config", "minsky", "local-mcp-token");
  try {
    const raw = readFileSync(tokenPath, "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    // intentional-swallow: no token file means "try unauthenticated"; a 401 then says so.
    return undefined;
  }
}

type Json = Record<string, unknown>;

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "verify-read-scope", version: "0.0.0-verify" });
  const token = resolveBearerToken();
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Json): Promise<Json> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  if (result.isError) throw new Error(`${name} errored: ${safeTruncate(text, 400)}`);
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error(`${name} returned non-JSON: ${safeTruncate(text, 400)}`);
  }
}

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
}

function scopeOf(r: Json): { kind?: string; source?: string; projectId?: string; reason?: string } {
  return (r.projectScope as Json | undefined) ?? {};
}

async function main(): Promise<void> {
  const url = argValue("--url") ?? "http://127.0.0.1:48799/mcp";
  const workspace = argValue("--workspace");
  const slug = argValue("--slug");
  const task = argValue("--task");
  const expectProjectId = argValue("--expect-project-id");
  if (!workspace || !slug || !task) {
    console.error(
      "usage: --workspace <path> --slug <owner/name> --task <mt#N> [--expect-project-id <uuid>]"
    );
    process.exit(2);
  }

  const health = await fetch(url.replace(/\/mcp$/, "/health"), {
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!health || !health.ok) {
    console.error(`FAIL(2): no daemon answering at ${url} — start one per the Usage block.`);
    process.exit(2);
  }

  const client = await connect(url);
  const noProjectDir = mkdtempSync(join(tmpdir(), "mt5155-noproject-"));
  try {
    // AT1 — config
    const cfg = await call(client, "config_show", { workspace, sources: true, json: true });
    // config.show's JSON result carries the resolved tree under `configuration`
    // and the per-source list (with `path`) under `sources` when --sources is set.
    const config = (cfg.configuration as Json | undefined) ?? {};
    const ws = (config.workspace as Json | undefined) ?? {};
    const repoCfg = (config.repository as Json | undefined) ?? {};
    const projectSource = ((cfg.sources as Array<Json> | undefined) ?? []).find(
      (s) => s.name === "project"
    );
    const projectSourcePath = String(projectSource?.path ?? "");
    check(
      "AT1 config_show workspace.mainPath is the named workspace",
      String(ws.mainPath ?? "") === workspace,
      `workspace.mainPath=${String(ws.mainPath)} harness=${String(ws.harness ?? "")}`
    );
    check(
      "AT1 config_show project source comes from the named workspace",
      projectSourcePath.startsWith(`${workspace}/`),
      `project source path=${projectSourcePath}; repository.url=${String(repoCfg.url ?? "")}`
    );

    // AT2 — tasks
    const listB = await call(client, "tasks_list", {
      workspace,
      json: true,
      all: true,
      limit: 500,
    });
    const tasksB = (listB.tasks as Array<Json>) ?? [];
    const idsB = tasksB.map((t) => String(t.id));
    const sB = scopeOf(listB);
    check(
      "AT2 tasks_list --workspace B scopes to B",
      sB.kind === "scoped" &&
        sB.source === "workspace" &&
        (!expectProjectId || sB.projectId === expectProjectId),
      `projectScope=${JSON.stringify(sB)} count=${tasksB.length}`
    );
    check(
      `AT2 tasks_list --workspace B includes ${task}`,
      idsB.includes(task),
      `ids=${safeTruncate(idsB.join(","), 200)}`
    );

    const listA = await call(client, "tasks_list", { json: true, all: true, limit: 2000 });
    const tasksA = (listA.tasks as Array<Json>) ?? [];
    const sA = scopeOf(listA);
    check(
      "AT2 control: tasks_list with no argument scopes to the daemon's cwd",
      sA.source === "cwd" && (!expectProjectId || sA.projectId !== expectProjectId),
      `projectScope=${JSON.stringify(sA)} count=${tasksA.length}`
    );
    const idsA = new Set(tasksA.map((t) => String(t.id)));
    const overlap = idsB.filter((id) => idsA.has(id));
    check(
      "AT2 B's rows are disjoint from the daemon's project's rows",
      tasksB.length > 0 && overlap.length === 0,
      `B=${tasksB.length} A=${tasksA.length} overlap=${overlap.length}`
    );

    const listNone = await call(client, "tasks_list", {
      workspace: noProjectDir,
      json: true,
      all: true,
    });
    const sNone = scopeOf(listNone);
    check(
      "AT2 tasks_list --workspace <no project> is unresolved and empty",
      sNone.kind === "unresolved" && ((listNone.tasks as unknown[]) ?? []).length === 0,
      `projectScope=${JSON.stringify(sNone)} count=${((listNone.tasks as unknown[]) ?? []).length}`
    );

    // AT3 — sessions
    for (const repo of [slug, workspace]) {
      const r = await call(client, "session_list", { repo, json: true, limit: 200 });
      const s = scopeOf(r);
      check(
        `AT3 session_list --repo ${repo} scopes to B`,
        s.kind === "scoped" && (!expectProjectId || s.projectId === expectProjectId),
        `projectScope=${JSON.stringify(s)} sessions=${((r.sessions as unknown[]) ?? []).length}`
      );
    }
    const rNone = await call(client, "session_list", { repo: "nonexistent/repo", json: true });
    const sN = scopeOf(rNone);
    check(
      "AT3 session_list --repo nonexistent/repo is unresolved with a reason, 0 rows",
      sN.kind === "unresolved" &&
        typeof sN.reason === "string" &&
        sN.reason.length > 0 &&
        ((rNone.sessions as unknown[]) ?? []).length === 0,
      `projectScope=${JSON.stringify(sN)} sessions=${((rNone.sessions as unknown[]) ?? []).length}`
    );

    // AT5 — presence claim stamped with B's project. The claim write is
    // fire-and-forget, and the list carries every actor's claim on the task
    // (a prior daemon's included), so the assertion reads the claim refreshed
    // by THIS call: the row whose lastRefreshedAt is newest.
    const before = Date.now();
    await call(client, "tasks_get", { taskId: task, workspace, json: true });
    await new Promise((r) => setTimeout(r, 2000));
    const claims = await call(client, "tasks_claims_list", { taskId: task, json: true });
    const rows = ((claims.claims as Array<Json>) ?? []).map((c) => ({
      actorId: String(c.actorId ?? ""),
      projectId: String(c.projectId ?? ""),
      lastRefreshedAt: String(c.lastRefreshedAt ?? ""),
    }));
    const newest = [...rows].sort((a, b) => b.lastRefreshedAt.localeCompare(a.lastRefreshedAt))[0];
    const refreshedByThisCall =
      newest !== undefined && Date.parse(newest.lastRefreshedAt) >= before - 1000;
    check(
      "AT5 the presence claim this call refreshed is stamped with B's project",
      refreshedByThisCall &&
        (expectProjectId ? newest.projectId === expectProjectId : newest.projectId.length > 0),
      `newest=${JSON.stringify(newest)} refreshedByThisCall=${refreshedByThisCall} expect=${expectProjectId ?? "(any)"}`
    );
  } finally {
    rmSync(noProjectDir, { recursive: true, force: true });
    await client.close().catch(() => undefined);
  }

  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
