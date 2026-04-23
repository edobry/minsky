/**
 * CategoryCommandHandler: hierarchy parsing and command-tree wiring.
 *
 * Regression coverage for mt#1159 — multi-word leaf `name` fields on dotted IDs
 * (e.g., id: "tasks.status.get", name: "status get") used to produce a third
 * nesting level, rendering the command unreachable (tasks status get status get).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Command } from "commander";
import {
  CategoryCommandHandler,
  type CategoryCommandHandlerDependencies,
} from "./category-command-handler";
import { CommandCategory, type SharedCommand } from "../../command-registry";

const ID_STATUS_GET = "tasks.status.get";
const ID_STATUS_SET = "tasks.status.set";
const ID_MODELS_LIST = "ai.models.list";

type HandlerWithPrivates = {
  parseCommandHierarchy: (commandDef: SharedCommand) => string[];
  addCommandWithNesting: (
    categoryCommand: Command,
    commandDef: SharedCommand,
    commandGroups: Map<string, Command>,
    context?: { viaFactory?: boolean }
  ) => void;
};

const makeCommandDef = (overrides: Partial<SharedCommand>): SharedCommand =>
  ({
    id: ID_STATUS_GET,
    name: "get",
    category: CommandCategory.TASKS,
    description: "Get the status of a task",
    parameters: {},
    execute: async () => undefined,
    ...overrides,
  }) as unknown as SharedCommand;

const makeHandler = (
  generateCommand: (id: string) => Command | null = (id) =>
    new Command().description(`desc for ${id}`).argument("<taskId>", "task id")
): { handler: CategoryCommandHandler; priv: HandlerWithPrivates } => {
  const deps: CategoryCommandHandlerDependencies = {
    customizationManager: {
      getCategoryOptions: () => ({}),
      registerCommandCustomization: () => undefined,
    } as unknown as CategoryCommandHandlerDependencies["customizationManager"],
    commandGenerator: {
      generateCommand: (id: string) => generateCommand(id),
    } as unknown as CategoryCommandHandlerDependencies["commandGenerator"],
  };
  const handler = new CategoryCommandHandler(deps);
  return { handler, priv: handler as unknown as HandlerWithPrivates };
};

const findSub = (cmd: Command, name: string): Command => {
  const match = cmd.commands.find((c) => c.name() === name);
  if (!match) {
    throw new Error(`Expected subcommand '${name}' under '${cmd.name()}', not found`);
  }
  return match;
};

describe("CategoryCommandHandler.parseCommandHierarchy", () => {
  it("dotted ID + single-word leaf name matching last segment -> idParts", () => {
    const { priv } = makeHandler();
    const parts = priv.parseCommandHierarchy(makeCommandDef({ id: ID_STATUS_GET, name: "get" }));
    expect(parts).toEqual(["status", "get"]);
  });

  it("dotted ID + multi-word name whose last word matches last segment -> idParts (no double-nesting)", () => {
    // Regression for mt#1159: before the fix, this returned
    // ["status", "get", "status get"] and produced an unreachable command path.
    const { priv } = makeHandler();
    const parts = priv.parseCommandHierarchy(
      makeCommandDef({ id: ID_STATUS_GET, name: "status get" })
    );
    expect(parts).toEqual(["status", "get"]);
  });

  it("dotted ID + single-word leaf name NOT matching last segment -> appends", () => {
    const { priv } = makeHandler();
    const parts = priv.parseCommandHierarchy(makeCommandDef({ id: ID_STATUS_GET, name: "fetch" }));
    expect(parts).toEqual(["status", "get", "fetch"]);
  });

  it("three-level dotted ID with matching single-word leaf -> full hierarchy", () => {
    const { priv } = makeHandler();
    const parts = priv.parseCommandHierarchy(
      makeCommandDef({
        id: ID_MODELS_LIST,
        name: "list",
        category: CommandCategory.AI,
      })
    );
    expect(parts).toEqual(["models", "list"]);
  });

  it("ID without dots falls back to splitting name on spaces (legacy support)", () => {
    const { priv } = makeHandler();
    const parts = priv.parseCommandHierarchy(
      makeCommandDef({ id: "legacy-command", name: "legacy command" })
    );
    expect(parts).toEqual(["legacy", "command"]);
  });
});

describe("CategoryCommandHandler CLI wiring for tasks.status.get / tasks.status.set", () => {
  let categoryCommand: Command;
  let commandGroups: Map<string, Command>;

  beforeEach(() => {
    categoryCommand = new Command("tasks").description("TASKS commands");
    commandGroups = new Map();
  });

  it("wires `tasks status get <taskId>` reachably — no phantom sub-subcommand under `get`", () => {
    const { priv } = makeHandler();
    priv.addCommandWithNesting(
      categoryCommand,
      makeCommandDef({ id: ID_STATUS_GET, name: "get" }),
      commandGroups
    );

    const status = findSub(categoryCommand, "status");
    const get = findSub(status, "get");
    // The leaf command accepts <taskId> as an argument...
    expect(get.usage()).toContain("<taskId>");
    // ...and has no further subcommands (the mt#1159 bug was a phantom "status get" here).
    expect(get.commands).toHaveLength(0);
  });

  it("wires `tasks status set <taskId>` reachably with a sibling `get`", () => {
    const { priv } = makeHandler();
    priv.addCommandWithNesting(
      categoryCommand,
      makeCommandDef({ id: ID_STATUS_GET, name: "get" }),
      commandGroups
    );
    priv.addCommandWithNesting(
      categoryCommand,
      makeCommandDef({
        id: ID_STATUS_SET,
        name: "set",
        description: "Set the status of a task",
      }),
      commandGroups
    );

    const status = findSub(categoryCommand, "status");
    const leaves = status.commands.map((c) => c.name()).sort();
    expect(leaves).toEqual(["get", "set"]);
    for (const leaf of status.commands) {
      expect(leaf.commands).toHaveLength(0);
      expect(leaf.usage()).toContain("<taskId>");
    }
  });

  it("tolerates a hypothetical multi-word `name` without double-nesting", () => {
    // Defensive guarantee: even if a command slips through with a multi-word name
    // like "status get", parseCommandHierarchy's last-word comparison prevents the
    // mt#1159 regression.
    const { priv } = makeHandler();
    priv.addCommandWithNesting(
      categoryCommand,
      makeCommandDef({ id: ID_STATUS_GET, name: "status get" }),
      commandGroups
    );

    const status = findSub(categoryCommand, "status");
    const get = findSub(status, "get");
    expect(get.commands).toHaveLength(0);
  });
});
