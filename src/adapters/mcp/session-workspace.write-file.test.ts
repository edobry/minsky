/* eslint-disable custom/no-real-fs-in-tests -- mt#3129 is specifically about
 * this MCP handler's REAL filesystem behavior: that an omitted `createDirs`
 * still creates parent directories, and that `created` reflects whether the
 * file existed on disk BEFORE the write. A mock fs cannot verify either — it
 * would assert the mock's own configured behavior, not that `mkdir`/`stat` were
 * actually invoked with the right effect. Uses an isolated mkdtemp dir cleaned
 * up in afterEach, mirroring the real-fs precedent in
 * substrate-bypass-detector.test.ts. The sibling session-workspace.lazy-di.test.ts
 * already dispatches this module's real handlers via a fake commandMapper. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerSessionWorkspaceTools } from "./session-workspace";

/** Extracted to satisfy custom/no-magic-string-duplication (Template Literal Pattern). */
const SESSION_ID = "test-session";
const TMP_PREFIX = "mt3129-";

type CapturedHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * Fake commandMapper that captures the RAW handler each tool registers, exactly
 * as session-workspace.lazy-di.test.ts does. Dispatching the captured handler
 * exercises the handler body directly — which is where mt#3129's fix lives
 * (`createDirs ?? true`, `created: !existedBefore`).
 */
function makeFakeCommandMapper(): {
  mapper: { addCommand: (cmd: { name: string; handler: CapturedHandler }) => void };
  handlers: Map<string, CapturedHandler>;
} {
  const handlers = new Map<string, CapturedHandler>();
  return {
    mapper: { addCommand: (cmd) => handlers.set(cmd.name, cmd.handler) },
    handlers,
  };
}

/**
 * Container stand-in whose `sessionProvider` resolves a session to `repoDir` —
 * the temp workspace root the handler writes under. `getSession` must return a
 * truthy record (resolveSessionDirectory throws on a falsy one); `getRepoPath`
 * returns the temp dir so resolved paths stay inside it and pass the
 * SessionPathResolver security check.
 */
function makeContainer(repoDir: string) {
  const provider = {
    getSession: async () => ({ session: "test-session" }),
    getRepoPath: async () => repoDir,
  };
  return {
    has: (key: string) => key === "sessionProvider",
    get: (key: string) => {
      if (key !== "sessionProvider") throw new Error(`unexpected key ${key}`);
      return provider;
    },
  };
}

function getWriteHandler(repoDir: string): CapturedHandler {
  const { mapper, handlers } = makeFakeCommandMapper();
  registerSessionWorkspaceTools(mapper as never, makeContainer(repoDir) as never);
  const handler = handlers.get("session.write_file");
  if (!handler) throw new Error("session.write_file handler not registered");
  return handler;
}

describe("session.write_file — createDirs default + created accuracy (mt#3129)", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test("omitting createDirs still creates missing parent directories", async () => {
    tempDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const handler = getWriteHandler(tempDir);

    const nestedPath = "new-parent/nested/file.txt";
    // createDirs is intentionally OMITTED — before mt#3129 this arrived
    // undefined (the addCommand path never materialized the schema default),
    // so mkdir was skipped and the write failed with ENOENT.
    const result = await handler({
      sessionId: SESSION_ID,
      path: nestedPath,
      content: "hello",
    });

    expect(result.error).toBeUndefined();
    expect(existsSync(join(tempDir, nestedPath))).toBe(true);
    expect(readFileSync(join(tempDir, nestedPath), "utf8")).toBe("hello");
  });

  test("writing a genuinely new file reports created: true", async () => {
    tempDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const handler = getWriteHandler(tempDir);

    const result = await handler({
      sessionId: SESSION_ID,
      path: "brand-new.txt",
      content: "fresh",
    });

    expect(result.error).toBeUndefined();
    expect(result.created).toBe(true);
  });

  test("overwriting an existing file reports created: false", async () => {
    tempDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const existingPath = "already-here.txt";
    // Seed the file on disk so the write is an overwrite, not a create.
    writeFileSync(join(tempDir, existingPath), "original");
    const handler = getWriteHandler(tempDir);

    const result = await handler({
      sessionId: SESSION_ID,
      path: existingPath,
      content: "replaced",
    });

    expect(result.error).toBeUndefined();
    // Before mt#3129 this was a hardcoded `created: true`.
    expect(result.created).toBe(false);
    expect(readFileSync(join(tempDir, existingPath), "utf8")).toBe("replaced");
  });

  test("createDirs: false is still honored (does not create parents)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const handler = getWriteHandler(tempDir);

    // Explicit false must still mean "do not create parent dirs" — the write
    // to a path under a missing directory fails, and the handler returns an
    // error response (it wraps its body in try/catch).
    const result = await handler({
      sessionId: SESSION_ID,
      path: "missing-parent/file.txt",
      content: "hi",
      createDirs: false,
    });

    expect(result.error).toBeDefined();
    expect(existsSync(join(tempDir, "missing-parent/file.txt"))).toBe(false);
  });
});
