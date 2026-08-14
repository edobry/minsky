import { describe, expect, test } from "bun:test";

import {
  hasUsedMcpSurface,
  manifestPath,
  mcpToolNameFor,
  minskyArgvOf,
  readManifest,
  renderWorstCase,
  resolveCommandId,
  scanCommand,
} from "./detect-cli-mcp-substitution";
import type { DispatchContext } from "./registry";

/**
 * The LIVE manifest, not a fixture — AT4's whole point. A fixture copy would pass while the real
 * oracle rotted, which is the failure mode `custom/require-hook-domain-bootstrap` (mt#3178) and
 * `custom/require-guard-outcome-in-fire-log` (mt#3920) both exist to prevent in their own trees.
 */
const loadedManifest = readManifest();
if (!loadedManifest) {
  // Fail loudly at load rather than letting every assertion below degrade to a
  // non-null assertion on null. A missing manifest is a generator regression,
  // which is precisely what AT4 exists to catch.
  throw new Error(
    `No completion manifest at ${manifestPath()} — run scripts/build-completion-manifest.ts`
  );
}
const manifest = loadedManifest;

/** The incident's canonical command id — used by both the AT1 table and the AT5 render check. */
const STATUS_SET_ID = "tasks.status.set";

function ctxWithToolNames(names: string[]): DispatchContext {
  const lines = names.map((name) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", name, input: {} }] },
  }));
  return { transcriptLines: lines } as unknown as DispatchContext;
}

describe("manifest oracle", () => {
  test("the resolved path points at a manifest with a populated command tree", () => {
    // Not `not.toBeNull()` — the module-level load already throws on null, so that
    // assertion would be tautological. Assert the shape the walk depends on.
    expect(manifestPath()).toContain("completion-manifest.json");
    expect((manifest.subcommands ?? []).length).toBeGreaterThan(10);
  });
});

describe("mcpToolNameFor", () => {
  test("dots become underscores under the mcp__minsky__ prefix", () => {
    expect(mcpToolNameFor(STATUS_SET_ID)).toBe("mcp__minsky__tasks_status_set");
    expect(mcpToolNameFor("asks.list")).toBe("mcp__minsky__asks_list");
  });
});

describe("minskyArgvOf", () => {
  test("recognizes the installed binary, bare and path-qualified", () => {
    expect(minskyArgvOf("minsky tasks get mt#1")).toEqual(["tasks", "get", "mt#1"]);
    expect(minskyArgvOf("/Users/x/.bun/bin/minsky tasks get")).toEqual(["tasks", "get"]);
  });

  test("recognizes the in-repo entry point in both bun spellings", () => {
    expect(minskyArgvOf("bun run src/cli.ts tasks get mt#1")).toEqual(["tasks", "get", "mt#1"]);
    expect(minskyArgvOf("bun src/cli.ts memory patch mem#1")).toEqual(["memory", "patch", "mem#1"]);
  });

  test("returns null for anything that is not the Minsky CLI", () => {
    expect(minskyArgvOf("git status")).toBeNull();
    expect(minskyArgvOf("bun run scripts/build-completion-manifest.ts")).toBeNull();
    expect(minskyArgvOf("")).toBeNull();
  });
});

describe("resolveCommandId", () => {
  test("skips flags so a global flag before a subcommand does not stop the walk", () => {
    const root = {
      name: "minsky",
      subcommands: [{ name: "tasks", subcommands: [{ name: "get", commandId: "tasks.get" }] }],
    };
    expect(resolveCommandId(root, ["--json", "tasks", "get", "mt#1"])).toBe("tasks.get");
  });

  test("returns null at a node carrying no commandId", () => {
    const root = { name: "minsky", subcommands: [{ name: "compile" }] };
    expect(resolveCommandId(root, ["compile", "--check"])).toBeNull();
  });
});

describe("AT1 — the originating incident's commands fire", () => {
  // Verbatim from the 2026-08-13 R10 turn (mem#707).
  const incidentCommands = [
    ['bun run src/cli.ts tasks status set "mt#3861" BLOCKED --json', STATUS_SET_ID],
    ['bun run src/cli.ts tasks get "mt#3812" --json', "tasks.get"],
    ["bun run src/cli.ts tasks spec get mt#3861", "tasks.spec.get"],
    ["bun run src/cli.ts memory get 01e6905b", "memory.get"],
    ["bun run src/cli.ts tools asks list --summary --limit 400", "asks.list"],
  ] as const;

  for (const [command, expectedId] of incidentCommands) {
    test(`${expectedId} resolves from: ${command.slice(0, 48)}`, () => {
      const result = scanCommand(command, manifest);
      expect(result.matched).toBe(true);
      expect(result.commandId).toBe(expectedId);
      expect(result.mcpToolName).toBe(mcpToolNameFor(expectedId));
    });
  }

  test("the TOOLS-category case resolves, which plain id-splitting cannot", () => {
    // `asks.list` mounts at `minsky tools asks list` — the category prefix is not in the id.
    const result = scanCommand("bun run src/cli.ts tools asks get f66b076d", manifest);
    expect(result.commandId).toBe("asks.get");
  });

  test("fires through a pipeline stage, since the substitution is usually piped to jq", () => {
    const result = scanCommand(
      "bun run src/cli.ts tasks get mt#1 --json | jq -r '.task'",
      manifest
    );
    expect(result.matched).toBe(true);
    expect(result.commandId).toBe("tasks.get");
  });
});

describe("AT2 — negative control: suppressed once the MCP surface is in use", () => {
  test("a session that already called an mcp__minsky__ tool is not reported", () => {
    const ctx = ctxWithToolNames(["Read", "mcp__minsky__tasks_get", "Bash"]);
    expect(hasUsedMcpSurface(ctx)).toBe(true);
  });

  test("a session with no mcp__minsky__ call is reportable", () => {
    const ctx = ctxWithToolNames(["Read", "Bash", "ToolSearch", "mcp__github__list_issues"]);
    expect(hasUsedMcpSurface(ctx)).toBe(false);
  });

  test("an empty transcript is reportable rather than silently suppressed", () => {
    expect(hasUsedMcpSurface({ transcriptLines: [] } as unknown as DispatchContext)).toBe(false);
  });
});

describe("AT3 — negative control: commands with no MCP equivalent never fire", () => {
  // The spec's original AT3 named `minsky compile` as the example. That was WRONG and the test
  // caught it: `mcp__minsky__compile` exists, so `compile` has an MCP form and firing on it is
  // correct behavior. The genuine negatives are nodes carrying no `commandId` at all — category
  // containers, which are Commander scaffolding rather than registry commands. Recorded in
  // mt#4144 `## Amendment (implementation)`.
  test("a bare category container does not fire", () => {
    expect(scanCommand("minsky tasks", manifest).matched).toBe(false);
  });

  test("a container one level down does not fire", () => {
    expect(scanCommand("minsky tasks deps --help", manifest).matched).toBe(false);
  });

  test("minsky compile DOES fire, because mcp__minsky__compile exists", () => {
    const result = scanCommand("minsky compile --check --target claude.md", manifest);
    expect(result.matched).toBe(true);
    expect(result.mcpToolName).toBe("mcp__minsky__compile");
  });

  test("a non-Minsky command does not fire", () => {
    expect(scanCommand("git log --oneline -5", manifest).matched).toBe(false);
  });

  test("building the manifest itself does not fire", () => {
    expect(scanCommand("bun run scripts/build-completion-manifest.ts", manifest).matched).toBe(
      false
    );
  });
});

describe("AT4 — coverage comes from the registry, not a hand-list", () => {
  test("the live manifest carries commandId on a broad set of leaves", () => {
    let stamped = 0;
    const walk = (node: { commandId?: string; subcommands?: unknown[] }) => {
      if (node.commandId) stamped++;
      for (const sub of (node.subcommands ?? []) as (typeof node)[]) walk(sub);
    };
    walk(manifest);
    // 227 stamped at authoring time; assert a floor rather than the exact count so adding a
    // command does not fail this test, while a generator regression that stamps nothing does.
    expect(stamped).toBeGreaterThan(150);
  });

  test("a command absent from the registry carries no id, so absence is the answer", () => {
    const result = scanCommand("minsky completion-server", manifest);
    expect(result.matched).toBe(false);
  });
});

describe("AT5 — worst-case advisory render", () => {
  test("names the command id, the MCP form, and the operator remedy", () => {
    const text = renderWorstCase();
    expect(text).toContain(STATUS_SET_ID);
    expect(text).toContain("mcp__minsky__tasks_status_set");
    expect(text).toContain("/mcp");
    expect(text).toContain("mt#4144");
  });

  test("stays within the declared attentionCost ceiling", () => {
    expect(renderWorstCase().length).toBeLessThanOrEqual(900);
  });
});
