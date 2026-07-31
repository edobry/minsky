/**
 * Regression test for the retirement of the `session.changeset.*` /
 * `session.cs.*` MCP alias command families (mt#2611).
 *
 * The task's acceptance test is "tools/list contains no session_cs_* or
 * session_changeset_* entries". This exercises the actual registration path
 * (`registerSessionCommands`) against the shared command registry — the
 * same registry the MCP `tools/list` surface is built from — so a future
 * re-introduction of either alias family fails a test instead of only being
 * caught by a code-review grep.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { registerSessionCommands } from "./session";
import { sharedCommandRegistry, CommandCategory } from "../command-registry";

describe("registerSessionCommands (mt#2611)", () => {
  const registeredIds: string[] = [];

  it("registers no session.changeset.* or session.cs.* alias commands", async () => {
    // Order-independence (mt#3022): the shared command registry is a
    // process-wide singleton, and bunfig.toml's `randomize: true` varies test
    // FILE execution order every run. If some other test file's own
    // registration pass (e.g. via the src/adapters/shared/commands/index.ts
    // aggregator) already populated the SESSION category before this test
    // runs, `registerSessionCommands()` below throws "already registered" on
    // its very first command instead of running cleanly. Unregistering any
    // pre-existing session-category commands first makes this test start
    // from a known-clean slate every time, independent of file order --
    // without weakening the assertion intent (the `before`/`after` diff below
    // still isolates exactly the commands THIS call registers).
    for (const cmd of sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION)) {
      sharedCommandRegistry.unregisterCommand(cmd.id);
    }

    const before = new Set(
      sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION).map((cmd) => cmd.id)
    );

    await registerSessionCommands();

    const after = sharedCommandRegistry.getCommandsByCategory(CommandCategory.SESSION);
    for (const cmd of after) {
      if (!before.has(cmd.id)) {
        registeredIds.push(cmd.id);
      }
    }

    const ids = after.map((cmd) => cmd.id);
    const aliasIds = ids.filter(
      (id) => id.startsWith("session.changeset.") || id.startsWith("session.cs.")
    );

    expect(aliasIds).toEqual([]);

    // Sanity check: the canonical family the aliases delegated to is still
    // registered, so an empty `aliasIds` isn't a false negative from a
    // broken/no-op registration call.
    expect(ids).toContain("session.pr.list");
    expect(ids).toContain("session.pr.get");
    expect(ids).toContain("session.pr.create");
    expect(ids).toContain("session.pr.approve");
    expect(ids).toContain("session.pr.merge");
    expect(ids).toContain("session.pr.edit");
  });

  afterAll(() => {
    for (const id of registeredIds) {
      sharedCommandRegistry.unregisterCommand(id);
    }
  });
});
