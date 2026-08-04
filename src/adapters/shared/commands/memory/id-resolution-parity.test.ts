/**
 * Drift guard: every id-taking `memory.*` command routes through the SHARED
 * resolver (mt#3108, SC4 — "a test asserts read and write paths resolve an
 * identical id set").
 *
 * This inspects the REGISTERED command's `execute` function rather than
 * invoking it, deliberately, because a behavioral test cannot discriminate
 * here: `resolveMemoryIdInput` fails open when no db is configured
 * (`resolveMemoryDbForPrefix` returns null → the input is returned unchanged),
 * so without a live Postgres every command "passes" whether or not it calls
 * the resolver at all. Checking the registered function is what actually pins
 * the wiring; the runtime behavior it delegates to is covered by
 * `packages/domain/src/memory/memory-service-{get,write}-id-forms.test.ts`.
 *
 * Reading the registry (not the file on disk) also keeps this honest in a
 * second way: it asserts against the artifact the MCP/CLI surfaces actually
 * execute, so moving a command to another module can't quietly evade it.
 *
 * The defect this guards: the resolver was wired into the READ commands when
 * `mem#N` shipped (mt#2966) and the WRITE commands were never swept, so
 * `memory_update` rejected ids `memory_get` accepted — surfacing as a raw
 * `invalid input syntax for type uuid` with the statement echoed back.
 */
import { describe, test, expect } from "bun:test";
import type { CommandDefinition, CommandParameterMap } from "../../command-registry";
import { registerMemoryCommands } from "./index";

/**
 * Every `memory.*` command that takes an EXISTING record's id. Commands
 * absent from this list take none (`search`, `list`, `create`).
 */
const ID_TAKING_COMMANDS: Array<{ id: string; kind: "read" | "write" }> = [
  { id: "memory.get", kind: "read" },
  { id: "memory.similar", kind: "read" },
  { id: "memory.lineage", kind: "read" },
  { id: "memory.update", kind: "write" },
  { id: "memory.patch", kind: "write" },
  { id: "memory.delete", kind: "write" },
  { id: "memory.supersede", kind: "write" },
];

/** Collect the command definitions into a throwaway registry. */
function registeredCommands(): Map<string, CommandDefinition<CommandParameterMap>> {
  const collected = new Map<string, CommandDefinition<CommandParameterMap>>();
  registerMemoryCommands({
    registerCommand: <T extends CommandParameterMap>(cmd: CommandDefinition<T>) => {
      collected.set(cmd.id, cmd as unknown as CommandDefinition<CommandParameterMap>);
    },
  });
  return collected;
}

const COMMANDS = registeredCommands();

/** True when a command's execute body calls the shared id resolver. */
function resolvesId(commandId: string): boolean {
  const cmd = COMMANDS.get(commandId);
  if (!cmd) throw new Error(`Command not registered: ${commandId}`);
  return String(cmd.execute).includes("resolveMemoryIdInput");
}

describe("memory command id-resolution parity (mt#3108)", () => {
  test("the guard's own command inventory matches what is registered", () => {
    // Without this, deleting a command from ID_TAKING_COMMANDS would silently
    // shrink the guard's coverage rather than fail it.
    for (const { id } of ID_TAKING_COMMANDS) {
      expect(COMMANDS.has(id)).toBe(true);
    }
  });

  for (const { id, kind } of ID_TAKING_COMMANDS) {
    test(`${id} (${kind}) routes its id through resolveMemoryIdInput`, () => {
      expect(resolvesId(id)).toBe(true);
    });
  }

  test("reads and writes resolve an IDENTICAL id set — no side-specific drift", () => {
    // The assertion SC4 names directly. Expressed as a per-side count rather
    // than six independent checks so a future command added on one side only
    // cannot pass by being absent from the other.
    const reads = ID_TAKING_COMMANDS.filter((c) => c.kind === "read");
    const writes = ID_TAKING_COMMANDS.filter((c) => c.kind === "write");

    expect(reads.filter((c) => resolvesId(c.id)).length).toBe(reads.length);
    expect(writes.filter((c) => resolvesId(c.id)).length).toBe(writes.length);
    expect(ID_TAKING_COMMANDS.filter((c) => resolvesId(c.id)).length).toBe(
      ID_TAKING_COMMANDS.length
    );
  });

  test("no id-taking command hands a raw params.<id> to the service", () => {
    // The exact pre-fix shape — `service.delete(params.id)` /
    // `service.supersede(params.oldId, ...)` — with no resolution step.
    for (const { id } of ID_TAKING_COMMANDS) {
      const body = String(COMMANDS.get(id)?.execute ?? "");
      expect(body).not.toMatch(/service\.\w+\(\s*params\.(id|oldId)\b/);
    }
  });
});
