/**
 * Regression tests for mt#4076 — parent/child option shadowing under `setup`.
 *
 * These drive the REAL command tree (`createSetupCommand()`) through
 * `parseAsync`, so the assertion covers the whole wired path: argv → commander's
 * binding → the action → `mergedSetupOpts` → `buildSetup*Params` → the params
 * the shared command actually receives.
 *
 * The capture seam is the registry's own `registerCommand`/`unregisterCommand`
 * API — the same API production uses to populate it — rather than a `spyOn`
 * patch of the singleton the action reaches. That distinction is why this file
 * does not need the stub the acceptance test suggested; see `/implement-task`
 * §6's testable-design checkpoint. Recorded in the task spec as a deviation.
 *
 * Each pair also pins the RAW commander behavior first — that `opts()` really
 * does drop the flag. That is the defect itself, asserted: if a future commander
 * stops shadowing, this fails and tells us the merge became redundant, instead
 * of the merge quietly becoming dead code.
 */

import { describe, test, expect, afterEach } from "bun:test";
import type { Command } from "commander";
import { buildSetupDbParams, createSetupCommand, mergedSetupOpts } from "./index";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
} from "../../adapters/shared/command-registry";

/** Flags and command ids repeated across the cases below. */
const CONNECTION_STRING = "--connection-string";
const GITHUB_APP_ID = "setup.github-app";
const PG_URL = "postgres://x/y";

const registered: string[] = [];

afterEach(() => {
  for (const id of registered.splice(0)) sharedCommandRegistry.unregisterCommand(id);
});

/**
 * Register a stand-in for `id` that records the params it is handed.
 *
 * Returns a box rather than the value because the action runs during
 * `parseAsync`, after this function has returned.
 */
function captureParamsFor(id: string): { params: Record<string, unknown> | undefined } {
  const box: { params: Record<string, unknown> | undefined } = { params: undefined };
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id,
      category: CommandCategory.INIT,
      name: id,
      description: `test capture for ${id}`,
      parameters: {},
      requiresSetup: false,
      execute: async (params: unknown) => {
        box.params = params as Record<string, unknown>;
        // The action calls process.exit(1) on a falsy success — which would
        // kill the test runner rather than fail a test.
        return { success: true };
      },
    })
  );
  registered.push(id);
  return box;
}

/** Parse argv against a real `setup` tree, running the real actions. */
async function runSetup(argv: string[]): Promise<Command> {
  const root = createSetupCommand();
  root.exitOverride();
  for (const child of root.commands) child.exitOverride();
  await root.parseAsync(argv, { from: "user" });
  return root;
}

function subcommand(root: Command, name: string): Command {
  const found = root.commands.find((c) => c.name() === name);
  if (found === undefined) throw new Error(`no '${name}' subcommand on the setup tree`);
  return found;
}

describe("setup db — the reported defect", () => {
  test("commander binds --connection-string and --yes to the PARENT, not to db", async () => {
    captureParamsFor("setup.db");
    const root = await runSetup(["db", CONNECTION_STRING, PG_URL, "--yes"]);
    const db = subcommand(root, "db");

    // This is the bug, asserted: the subcommand's own view is empty.
    expect(db.opts().connectionString).toBeUndefined();
    expect(db.opts().yes).toBe(false);
    // ...and the parent holds what the operator typed.
    expect(root.opts().connectionString).toBe("postgres://x/y");
    expect(root.opts().yes).toBe(true);
  });

  test("AT2: --connection-string reaches the shared command's params", async () => {
    const captured = captureParamsFor("setup.db");
    await runSetup(["db", CONNECTION_STRING, PG_URL]);
    expect(captured.params?.connectionString).toBe("postgres://x/y");
  });

  test("--yes reaches it too — the reported symptom hid a second dropped flag", async () => {
    const captured = captureParamsFor("setup.db");
    await runSetup(["db", CONNECTION_STRING, PG_URL, "--yes"]);
    expect(captured.params).toEqual({ connectionString: PG_URL, yes: true });
  });

  test("an unpassed --yes still defaults to false", async () => {
    const captured = captureParamsFor("setup.db");
    await runSetup(["db", CONNECTION_STRING, PG_URL]);
    expect(captured.params?.yes).toBe(false);
  });
});

describe("setup github-app — the same shape, one command over", () => {
  test("commander binds --repo to the PARENT, not to github-app", async () => {
    captureParamsFor(GITHUB_APP_ID);
    const root = await runSetup(["github-app", "--name", "x", "--repo", "owner/name"]);
    const app = subcommand(root, "github-app");

    expect(app.opts().repo).toBeUndefined();
    // --name is declared ONLY on the subcommand, so it is unaffected. Asserted
    // so a failure distinguishes "shadowing" from "parsing is broken".
    expect(app.opts().name).toBe("x");
  });

  test("AT1: --repo reaches the shared command's params", async () => {
    const captured = captureParamsFor(GITHUB_APP_ID);
    await runSetup(["github-app", "--name", "x", "--repo", "owner/name"]);
    expect(captured.params?.repo).toBe("owner/name");
    expect(captured.params?.name).toBe("x");
  });

  test("a flag the parent does NOT declare survives the merge", async () => {
    const captured = captureParamsFor(GITHUB_APP_ID);
    await runSetup(["github-app", "--name", "x", "--repo", "owner/name", "--via", "wizard"]);
    expect(captured.params?.via).toBe("wizard");
  });
});

describe("setup local-http — fixed by mt#3816, kept from regressing", () => {
  test("--repo reaches the params", async () => {
    const captured = captureParamsFor("setup.local-http");
    await runSetup(["local-http", "--repo", "/w/proj"]);
    expect(captured.params?.repo).toBe("/w/proj");
  });

  test("--execute is subcommand-only and survives the merge", async () => {
    const captured = captureParamsFor("setup.local-http");
    await runSetup(["local-http", "--repo", "/w/proj", "--execute"]);
    expect(captured.params?.execute).toBe(true);
  });
});

describe("the parent's own invocation is undisturbed", () => {
  test("bare `setup --repo X --connection-string Y` still sees its own options", async () => {
    // The Out-of-scope decision (leave the parent's option set alone) rests on
    // this: reading the merged view in the CHILDREN changes nothing for the
    // parent, whose --repo is load-bearing for bare `minsky setup`.
    const captured = captureParamsFor("setup");
    await runSetup(["--repo", "/w/proj", "--connection-string", "postgres://a/b"]);
    expect(captured.params?.repo).toBe("/w/proj");
    expect(captured.params?.connectionString).toBe("postgres://a/b");
  });
});

describe("mergedSetupOpts", () => {
  test("falls back to the plain options when handed no command", () => {
    // Keeps the actions callable with a bare object, and keeps the helper
    // usable on a commander that predates optsWithGlobals.
    expect(mergedSetupOpts({ repo: "x" })).toEqual({ repo: "x" });
  });

  test("falls back when the command lacks optsWithGlobals", () => {
    const notACommand = {} as Command;
    expect(mergedSetupOpts({ repo: "x" }, notACommand)).toEqual({ repo: "x" });
  });
});

describe("buildSetupDbParams", () => {
  test("maps option names to param names and defaults --yes", () => {
    expect(buildSetupDbParams({ connectionString: "postgres://a/b" })).toEqual({
      connectionString: "postgres://a/b",
      yes: false,
    });
  });
});
