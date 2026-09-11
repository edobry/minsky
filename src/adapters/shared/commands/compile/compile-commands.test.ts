/**
 * mt#4394 — `compile` carries the same session routing as `validate_typecheck` /
 * `validate_lint`, and reports the directory it actually compiled.
 *
 * The routing is asserted THROUGH THE FILESYSTEM, not through a spy on
 * `runMinskyCompile`: the real domain function runs over a fake `fsDeps`
 * holding two workspaces — a main tree and a session tree, each with its own
 * `.minsky/hooks/` source — and the test reads back which tree gained output.
 * A recorded-arguments fake would only prove the adapter passed a string
 * along; the fake fs proves the string reached the writes.
 *
 * `claude-hooks` is the target used because it reads and writes entirely via
 * `fsDeps`; `claude-skills` compiles TypeScript definition MODULES, which a
 * fake filesystem cannot serve. The routing is target-independent — see the
 * spec's planning audit for the substitution.
 */
import { describe, test, expect } from "bun:test";
import type { CommandDefinition, CommandParameterMap } from "../../command-registry";
import type { MinskyCompileFsDeps } from "@minsky/domain/compile/types";
import { runMinskyCompile } from "@minsky/domain/compile/compile";
import { registerCompileCommands } from "./compile-commands";
import type { CompileCommandDeps, CompileCommandResult } from "./compile-commands";

const MAIN = "/work/minsky";
const SESSION = "/state/minsky/sessions/sess-1";
const HOOK_SOURCE = "#!/usr/bin/env bun\nexport const run = () => null;\n";

/** A fake `MinskyCompileFsDeps` over a path → content map; writes land in `store`. */
function makeFakeFs(initial: Record<string, string>): {
  store: Record<string, string>;
  fs: MinskyCompileFsDeps;
} {
  const store: Record<string, string> = { ...initial };
  const enoent = (p: string): Error =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
  const fs: MinskyCompileFsDeps = {
    async readFile(p: string): Promise<string> {
      const c = store[p];
      if (c === undefined) throw enoent(p);
      return c;
    },
    async writeFile(p: string, data: string): Promise<void> {
      store[p] = data;
    },
    async mkdir(): Promise<undefined> {
      return undefined;
    },
    async readdir(dir: string): Promise<string[]> {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0] ?? "");
      }
      if (names.size === 0) throw enoent(dir);
      return [...names].filter((n) => n !== "");
    },
    async access(p: string): Promise<void> {
      const prefix = p.endsWith("/") ? p : `${p}/`;
      if (store[p] === undefined && !Object.keys(store).some((k) => k.startsWith(prefix))) {
        throw enoent(p);
      }
    },
    async chmod(): Promise<void> {},
  };
  return { store, fs };
}

/** Two workspaces, each with one hook source and no compiled output yet. */
function twoWorkspaces(): ReturnType<typeof makeFakeFs> {
  return makeFakeFs({
    [`${MAIN}/.minsky/hooks/probe.ts`]: HOOK_SOURCE,
    [`${SESSION}/.minsky/hooks/probe.ts`]: HOOK_SOURCE,
  });
}

/**
 * A container whose `sessionDeps` resolve `task: "mt#1"` and `sessionId:
 * "sess-1"` to `SESSION` — the lookups `resolveSessionContext` (task →
 * `getSessionByTaskId`, sessionId → `getSession`) and `buildSessionDirResolver`
 * (`getSessionWorkdir`) make, and nothing else.
 */
function fakeContainer(): Parameters<typeof registerCompileCommands>[1] {
  const record = { sessionId: "sess-1", taskId: "mt#1" };
  const sessionProvider = {
    async getSessionByTaskId(taskId: string) {
      return taskId === "mt#1" ? record : null;
    },
    async listSessions() {
      return [record];
    },
    async getSession(id: string) {
      return id === "sess-1" ? record : null;
    },
    async getSessionWorkdir(id: string) {
      if (id !== "sess-1") throw new Error(`no such session ${id}`);
      return SESSION;
    },
  };
  return {
    has: (key: string) => key === "sessionDeps",
    get: () => ({ sessionProvider }),
  } as unknown as Parameters<typeof registerCompileCommands>[1];
}

/** Register into a capturing registry and return the command's execute, bound to `fs`. */
function compileOver(
  fs: MinskyCompileFsDeps,
  container?: Parameters<typeof registerCompileCommands>[1]
): (params: Record<string, unknown>) => Promise<CompileCommandResult> {
  let captured: CommandDefinition<CommandParameterMap> | undefined;
  const deps: CompileCommandDeps = {
    runMinskyCompile: (options) => runMinskyCompile({ ...options, fsDeps: fs }),
    cwd: () => MAIN,
  };
  registerCompileCommands(
    {
      registerCommand: (cmd) => {
        captured = cmd as unknown as CommandDefinition<CommandParameterMap>;
      },
    },
    container,
    deps
  );
  if (!captured) throw new Error("compile command was not registered");
  const def = captured;
  return (params) =>
    def.execute({ dryRun: false, check: false, overwrite: false, ...params }, {
      interface: "test",
    } as never) as Promise<CompileCommandResult>;
}

describe("compile — session routing (mt#4394)", () => {
  test("AT3: no routing argument compiles the cwd, exactly as before", async () => {
    const { store, fs } = twoWorkspaces();
    const result = await compileOver(fs)({ target: "claude-hooks" });
    expect(result.compiledWorkspace).toBe(MAIN);
    expect(store[`${MAIN}/.claude/hooks/probe.ts`]).toContain("export const run");
    expect(store[`${SESSION}/.claude/hooks/probe.ts`]).toBeUndefined();
  });

  test("AT1: `task` compiles THAT session's workspace and leaves main byte-unchanged", async () => {
    const { store, fs } = twoWorkspaces();
    const mainBefore = { ...store };
    const result = await compileOver(fs, fakeContainer())({ task: "mt#1", target: "claude-hooks" });
    expect(result.compiledWorkspace).toBe(SESSION);
    expect(store[`${SESSION}/.claude/hooks/probe.ts`]).toContain("export const run");
    // Every main-tree entry is what it was, and main gained nothing.
    for (const [key, value] of Object.entries(mainBefore)) {
      if (key.startsWith(`${MAIN}/`)) expect(store[key]).toBe(value);
    }
    expect(Object.keys(store).filter((k) => k.startsWith(`${MAIN}/.claude/`))).toEqual([]);
  });

  test("`sessionId` routes the same way", async () => {
    const { store, fs } = twoWorkspaces();
    const result = await compileOver(
      fs,
      fakeContainer()
    )({
      sessionId: "sess-1",
      target: "claude-hooks",
    });
    expect(result.compiledWorkspace).toBe(SESSION);
    expect(store[`${SESSION}/.claude/hooks/probe.ts`]).toBeDefined();
  });

  test("an explicit `workspace` wins over `task`", async () => {
    const { store, fs } = twoWorkspaces();
    const result = await compileOver(
      fs,
      fakeContainer()
    )({
      workspace: MAIN,
      task: "mt#1",
      target: "claude-hooks",
    });
    expect(result.compiledWorkspace).toBe(MAIN);
    expect(store[`${SESSION}/.claude/hooks/probe.ts`]).toBeUndefined();
  });

  test("AT2: `check` with routing reports drift for the SESSION's source-vs-output pair", async () => {
    // Session output is stale (compiled from an older source); main is fresh
    // — a check routed to main would pass, so a pass here would be the bug.
    const fresh = twoWorkspaces();
    await compileOver(fresh.fs)({ target: "claude-hooks" });
    const mainOutput = fresh.store[`${MAIN}/.claude/hooks/probe.ts`] ?? "";
    const { fs } = makeFakeFs({
      [`${MAIN}/.minsky/hooks/probe.ts`]: HOOK_SOURCE,
      [`${MAIN}/.claude/hooks/probe.ts`]: mainOutput,
      [`${SESSION}/.minsky/hooks/probe.ts`]: `${HOOK_SOURCE}// edited in the session\n`,
      [`${SESSION}/.claude/hooks/probe.ts`]: mainOutput,
    });
    await expect(
      compileOver(fs, fakeContainer())({ task: "mt#1", check: true, target: "claude-hooks" })
    ).rejects.toThrow(/stale/);
    // And the same check against main, which IS current, passes.
    const clean = await compileOver(fs, fakeContainer())({ check: true, target: "claude-hooks" });
    expect(clean.compiledWorkspace).toBe(MAIN);
    expect(clean.stale).toBeFalsy();
  });

  test("routing to a task with no container is an error, never a silent compile of main", async () => {
    const { store, fs } = twoWorkspaces();
    await expect(compileOver(fs)({ task: "mt#1", target: "claude-hooks" })).rejects.toThrow(
      /Cannot resolve session workspace/
    );
    expect(store[`${MAIN}/.claude/hooks/probe.ts`]).toBeUndefined();
  });

  test("the routing parameters carry no default — a default would starve the session leg", () => {
    let captured: CommandDefinition<CommandParameterMap> | undefined;
    registerCompileCommands({
      registerCommand: (cmd) => {
        captured = cmd as unknown as CommandDefinition<CommandParameterMap>;
      },
    });
    const params = captured?.parameters ?? {};
    for (const name of ["workspace", "task", "sessionId"]) {
      expect(name in params).toBe(true);
      expect("defaultValue" in (params[name] ?? {})).toBe(false);
    }
  });
});
