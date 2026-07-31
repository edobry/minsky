/**
 * Tests for `session focus` / `session goto` (mt#2285).
 *
 * HARD sandbox constraint: no real AppleScript/tmux/wezterm/kitty invocation
 * ever runs here. Whenever a test needs an attachment whose terminalContext
 * would resolve to a real adapter, a mock CommandExecutor is injected via
 * `getFocusExecutor` -- the command never falls through to
 * `defaultCommandExecutor` in these tests.
 */
import { hostname } from "node:os";
import { describe, test, expect, mock } from "bun:test";
import { createSessionFocusCommand, createSessionGotoCommand } from "./focus-command";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import type { SessionCommandDependencies } from "./types";
import type { CommandExecutor } from "@minsky/domain/session/index";

function buildGetDeps(
  overrides: Partial<SessionCommandDependencies> = {}
): () => Promise<SessionCommandDependencies> {
  return async () => overrides as unknown as SessionCommandDependencies;
}

/** Chainable fake db matching the drizzle select surface the presence repo uses. */
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

function makeGetPersistenceProvider(db: unknown): () => PersistenceProvider | undefined {
  const sqlProvider = {
    getDatabaseConnection: mock(async () => db),
  } as unknown as SqlCapablePersistenceProvider;
  return () => sqlProvider as unknown as PersistenceProvider;
}

/** Build a presence-claim row shape matching what listLiveSessionAttachments expects to read. */
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
    lastRefreshedAt: now,
  };
}

describe("createSessionFocusCommand", () => {
  test("fails when no session id or task can be resolved", async () => {
    const command = createSessionFocusCommand(buildGetDeps(), undefined, undefined);
    const result = (await command.execute({}, {})) as { success: boolean; message: string };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Could not resolve a session id/);
  });

  test("fails with a clear message when no DB connection is available", async () => {
    const command = createSessionFocusCommand(buildGetDeps(), undefined, undefined);
    const result = (await command.execute({ sessionId: "session-x" }, {})) as {
      success: boolean;
      message: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No database connection/);
  });

  test("reports 'nothing attached' when there are no live attachments", async () => {
    const db = makeFakeDb([]);
    const getPersistenceProvider = makeGetPersistenceProvider(db);
    const command = createSessionFocusCommand(buildGetDeps(), getPersistenceProvider, undefined);

    const result = (await command.execute({ sessionId: "session-x" }, {})) as {
      success: boolean;
      message: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Nothing attached to session session-x/);
  });

  test("focuses the single live attachment via the injected executor", async () => {
    const row = makeAttachmentRow({ terminalContext: { TMUX_PANE: "%3" } });
    const db = makeFakeDb([row]);
    const getPersistenceProvider = makeGetPersistenceProvider(db);

    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const getFocusExecutor = () => executor;

    const command = createSessionFocusCommand(
      buildGetDeps(),
      getPersistenceProvider,
      getFocusExecutor
    );
    const result = (await command.execute({ sessionId: "session-x" }, {})) as {
      success: boolean;
      message: string;
      outcomeKind: string;
      adapter: string;
    };

    expect(result.success).toBe(true);
    expect(result.outcomeKind).toBe("focused");
    expect(result.adapter).toBe("tmux");
    expect(calls[0]).toEqual(["tmux", "select-window", "-t", "%3"]);
  });

  test("reports a 'no known focus mechanism' outcome without invoking the executor when terminalContext is empty", async () => {
    const row = makeAttachmentRow({ terminalContext: {} });
    const db = makeFakeDb([row]);
    const getPersistenceProvider = makeGetPersistenceProvider(db);

    const executor: CommandExecutor = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const command = createSessionFocusCommand(
      buildGetDeps(),
      getPersistenceProvider,
      () => executor
    );

    const result = (await command.execute({ sessionId: "session-x" }, {})) as {
      success: boolean;
      outcomeKind: string;
      message: string;
    };

    expect(result.success).toBe(false);
    expect(result.outcomeKind).toBe("no-signal");
    expect(executor).not.toHaveBeenCalled();
  });

  test("lists candidate attachments and requires a selector when multiple are live", async () => {
    const rows = [
      makeAttachmentRow({ id: "att-1", terminalContext: {} }),
      makeAttachmentRow({ id: "att-2", terminalContext: {} }),
    ];
    const db = makeFakeDb(rows);
    const getPersistenceProvider = makeGetPersistenceProvider(db);
    const command = createSessionFocusCommand(buildGetDeps(), getPersistenceProvider, undefined);

    const result = (await command.execute({ sessionId: "session-x" }, {})) as {
      success: boolean;
      message: string;
      attachments: unknown[];
    };

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/has 2 live attachments/);
    expect(result.message).toContain("att-1");
    expect(result.message).toContain("att-2");
    expect(result.attachments).toHaveLength(2);
  });

  test("focuses the selected attachment when --attachment matches one of several", async () => {
    const rows = [
      makeAttachmentRow({ id: "att-1", terminalContext: { KITTY_WINDOW_ID: "1" } }),
      makeAttachmentRow({ id: "att-2", terminalContext: { WEZTERM_PANE: "2" } }),
    ];
    const db = makeFakeDb(rows);
    const getPersistenceProvider = makeGetPersistenceProvider(db);

    const calls: string[][] = [];
    const executor: CommandExecutor = mock(async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const command = createSessionFocusCommand(
      buildGetDeps(),
      getPersistenceProvider,
      () => executor
    );
    const result = (await command.execute({ sessionId: "session-x", attachment: "att-2" }, {})) as {
      success: boolean;
      adapter: string;
    };

    expect(result.success).toBe(true);
    expect(result.adapter).toBe("WezTerm");
    expect(calls[0]).toEqual(["wezterm", "cli", "activate-pane", "--pane-id", "2"]);
  });

  test("fails with a clear message when --attachment doesn't match any known id", async () => {
    const rows = [
      makeAttachmentRow({ id: "att-1", terminalContext: {} }),
      makeAttachmentRow({ id: "att-2", terminalContext: {} }),
    ];
    const db = makeFakeDb(rows);
    const getPersistenceProvider = makeGetPersistenceProvider(db);
    const command = createSessionFocusCommand(buildGetDeps(), getPersistenceProvider, undefined);

    const result = (await command.execute({ sessionId: "session-x", attachment: "nope" }, {})) as {
      success: boolean;
      message: string;
    };

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No attachment with id "nope"/);
  });
});

describe("createSessionGotoCommand", () => {
  test("is a thin alias sharing session.focus's execute behavior", async () => {
    const db = makeFakeDb([]);
    const getPersistenceProvider = makeGetPersistenceProvider(db);
    const command = createSessionGotoCommand(buildGetDeps(), getPersistenceProvider, undefined);

    expect(command.id).toBe("session.goto");
    expect(command.name).toBe("goto");

    const result = (await command.execute({ sessionId: "session-x" }, {})) as {
      success: boolean;
      message: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Nothing attached/);
  });
});
