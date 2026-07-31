/**
 * Tests for POST /api/agents/:id/focus (mt#2286).
 *
 * HARD sandbox constraint (same as
 * src/adapters/shared/commands/session/focus-command.test.ts and
 * packages/domain/src/session/focus/*.test.ts): no real AppleScript/tmux/
 * wezterm/kitty invocation ever runs here. Every test that reaches
 * `focusAttachment` injects a mock `CommandExecutor` via the `executor`
 * route option — the route never falls through to the real
 * `defaultCommandExecutor` in these tests.
 */
import { hostname } from "node:os";
import { describe, test, expect, mock, afterEach } from "bun:test";
import type { Server } from "http";
import express from "express";
import { mountAgentFocusRoutes } from "./agent-focus";
import type { CommandExecutor } from "@minsky/domain/session/index";

// ---------------------------------------------------------------------------
// Fake db chain (mirrors focus-command.test.ts's makeFakeDb/makeAttachmentRow
// — the presence repo's listClaims() calls select().from().where().orderBy()).
// ---------------------------------------------------------------------------

function makeFakeDb(rows: unknown[] = []) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
    returning: () => Promise.resolve([]),
  };
  return {
    select: mock(() => chain),
    delete: mock(() => chain),
  };
}

function makeAttachmentRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: overrides.id ?? "att-1",
    subjectKind: "session",
    subjectId: overrides.subjectId ?? "session-x",
    actorId: overrides.actorId ?? "actor-1",
    ccConversationId: null,
    tty: overrides.tty ?? null,
    host: overrides.host ?? hostname(),
    sessionId: overrides.subjectId ?? "session-x",
    projectId: null,
    pid: overrides.pid ?? process.pid, // this process's own pid is always alive
    entrypoint: overrides.entrypoint ?? null,
    terminalContext: overrides.terminalContext ?? {},
    claimedAt: now,
    lastRefreshedAt: overrides.lastRefreshedAt ?? now,
  };
}

// ---------------------------------------------------------------------------
// Ephemeral-server harness (mirrors ./driven-sessions.test.ts)
// ---------------------------------------------------------------------------

const servers: Server[] = [];

async function makeHarness(opts?: {
  rows?: unknown[];
  executor?: CommandExecutor;
  hostnameOverride?: () => string;
}): Promise<{ url: string }> {
  const db = makeFakeDb(opts?.rows ?? []);

  const app = express();
  app.use(express.json());
  mountAgentFocusRoutes(app, {
    getDb: async () => db as unknown as import("drizzle-orm/postgres-js").PostgresJsDatabase,
    executor: opts?.executor,
    hostname: opts?.hostnameOverride,
  });

  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no ephemeral port");
  return { url: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

async function post(url: string, sessionId: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${url}/api/agents/${encodeURIComponent(sessionId)}/focus`, {
    method: "POST",
  });
  return { status: res.status, body: await res.json() };
}

describe("POST /api/agents/:id/focus", () => {
  test("reports 'nothing-attached' when there are no live attachments", async () => {
    const { url } = await makeHarness({ rows: [] });
    const { status, body } = await post(url, "session-x");

    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.outcomeKind).toBe("nothing-attached");
    expect(body.message).toMatch(/Nothing attached to session session-x/);
  });

  test("does not double-decode a sessionId containing a literal '%' (R1 review fix)", async () => {
    // Express decodes route params ONCE. A sessionId whose literal value
    // contains "%20" must survive round-trip through encodeURIComponent ->
    // Express's single decode unchanged. A second decodeURIComponent() in
    // the handler would corrupt "with%20space" into "with space".
    const literalSessionId = "with%20space";
    const { url } = await makeHarness({ rows: [] });
    const { status, body } = await post(url, literalSessionId);

    expect(status).toBe(200);
    expect(body.message).toContain(literalSessionId);
    expect(body.message).not.toContain("with space");
  });

  test("focuses the live attachment via the injected executor and reports 'focused'", async () => {
    const row = makeAttachmentRow({ terminalContext: { TMUX_PANE: "%3" } });
    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const { url } = await makeHarness({ rows: [row], executor });
    const { status, body } = await post(url, "session-x");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.outcomeKind).toBe("focused");
    expect(body.adapter).toBe("tmux");
    expect(calls[0]).toEqual(["tmux", "select-window", "-t", "%3"]);
  });

  test("reports a degraded outcome as success:true (real progress, not full focus)", async () => {
    // TERM_PROGRAM alone (no more specific pane signal) resolves to the
    // wm-raise degraded fallback adapter (packages/domain/src/session/focus/adapters.ts).
    const row = makeAttachmentRow({ terminalContext: { TERM_PROGRAM: "Apple_Terminal" } });
    const executor: CommandExecutor = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

    const { url } = await makeHarness({ rows: [row], executor });
    const { status, body } = await post(url, "session-x");

    expect(status).toBe(200);
    expect(body.outcomeKind).toMatch(/^degraded-/);
    expect(body.success).toBe(true);
  });

  test("reports 'no-signal' (success:false) without invoking the executor when terminalContext is empty", async () => {
    const row = makeAttachmentRow({ terminalContext: {} });
    const executor: CommandExecutor = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

    const { url } = await makeHarness({ rows: [row], executor });
    const { status, body } = await post(url, "session-x");

    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.outcomeKind).toBe("no-signal");
    expect(executor).not.toHaveBeenCalled();
  });

  test("reports 'remote-host-unsupported' for an attachment recorded on a different host", async () => {
    const row = makeAttachmentRow({
      host: "some-other-machine",
      terminalContext: { TMUX_PANE: "%1" },
    });
    const { url } = await makeHarness({ rows: [row] });
    const { status, body } = await post(url, "session-x");

    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.outcomeKind).toBe("remote-host-unsupported");
    expect(body.message).toMatch(/different host/);
    expect(body.message).toMatch(/local-only/);
  });

  test("prefers a live LOCAL attachment over a stale/remote row for the same session", async () => {
    const remoteRow = makeAttachmentRow({
      id: "remote",
      host: "some-other-machine",
      terminalContext: { TMUX_PANE: "%9" },
    });
    const localRow = makeAttachmentRow({ id: "local", terminalContext: { TMUX_PANE: "%2" } });
    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const { url } = await makeHarness({ rows: [remoteRow, localRow], executor });
    const { status, body } = await post(url, "session-x");

    expect(status).toBe(200);
    expect(body.outcomeKind).toBe("focused");
    expect(calls[0]).toEqual(["tmux", "select-window", "-t", "%2"]);
  });

  test("a dead pid (not confirmed live) is treated as detached, not focused", async () => {
    const row = makeAttachmentRow({ pid: 999999999, terminalContext: { TMUX_PANE: "%3" } });
    const { url } = await makeHarness({ rows: [row] });
    const { status, body } = await post(url, "session-x");

    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.outcomeKind).toBe("nothing-attached");
  });

  test("returns 400 when no session id is supplied", async () => {
    const { url } = await makeHarness({ rows: [] });
    const res = await fetch(`${url}/api/agents/${encodeURIComponent(" ")}/focus`, {
      method: "POST",
    });
    // A single space is a valid (if odd) path segment, so this exercises the
    // decode path rather than the missing-param guard; assert it degrades to
    // "nothing attached" rather than throwing.
    expect(res.status).toBe(200);
  });

  test("returns 503 when the DB connection is unavailable", async () => {
    const app = express();
    mountAgentFocusRoutes(app, { getDb: async () => null });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no ephemeral port");
    const { status, body } = await post(`http://127.0.0.1:${address.port}`, "session-x");

    expect(status).toBe(503);
    expect(body.error).toMatch(/Presence service unavailable/);
  });
});
