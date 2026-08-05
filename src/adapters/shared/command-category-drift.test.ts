/**
 * CommandCategory drift-check
 *
 * `CommandCategory` is enumerated twice: as a TypeScript enum in
 * `src/adapters/shared/command-registry.ts`, and as a hand-maintained
 * `z.enum([...])` in `packages/domain/src/schemas/command-registry.ts`. The
 * registry validates every command definition against the zod schema at
 * registration time (`validateCommandDefinition`, called from
 * `SharedCommandRegistry.register`), so a value added to the enum but not the
 * schema throws a ZodError that lists every valid category and names no file —
 * a late, unhelpful failure. Observed in mt#3228 when `PRINCIPAL` was added.
 *
 * ADR-011 (`docs/architecture/adr-011-mcp-bridge-discovery.md`) §Behavioral
 * guarantee makes the mirror an explicit step of the accepted add-a-category
 * procedure: "Adding a new `CommandCategory.X` to the enum + the Zod schema
 * mirror + registering an `X.*` command in the shared registry is sufficient to
 * expose it via MCP." Nothing enforced that second step. This test does.
 *
 * Pure unit test — no DB, no filesystem, no network.
 */

import { describe, test, expect } from "bun:test";
import { commandCategorySchema } from "@minsky/domain/schemas/command-registry";
import { CommandCategory } from "./command-registry";

const TS_ENUM_PATH = "src/adapters/shared/command-registry.ts";
const ZOD_SCHEMA_PATH = "packages/domain/src/schemas/command-registry.ts";

/**
 * Describes how two category enumerations differ, or returns "" when they hold
 * the same set. Comparison is set-based, so declaration order does not matter —
 * the two lists genuinely differ in order today.
 *
 * Kept as a pure function so the drift-detection logic can be exercised against
 * a known-divergent pair. A check that has never been observed failing is not
 * known to discriminate (mt#3244), and the drift case cannot be reached from
 * the real enumerations while they agree.
 */
function describeCategoryDrift(enumValues: string[], schemaValues: string[]): string {
  const inSchema = new Set(schemaValues);
  const inEnum = new Set(enumValues);
  const missingFromSchema = enumValues.filter((value) => !inSchema.has(value)).sort();
  const missingFromEnum = schemaValues.filter((value) => !inEnum.has(value)).sort();

  const problems: string[] = [];
  if (missingFromSchema.length > 0) {
    problems.push(
      `Present in ${TS_ENUM_PATH} but MISSING from ${ZOD_SCHEMA_PATH}: ` +
        `${missingFromSchema.join(", ")}. Add to the z.enum([...]) list in ` +
        `commandCategorySchema.`
    );
  }
  if (missingFromEnum.length > 0) {
    problems.push(
      `Present in ${ZOD_SCHEMA_PATH} but MISSING from ${TS_ENUM_PATH}: ` +
        `${missingFromEnum.join(", ")}. Add to the CommandCategory enum.`
    );
  }
  return problems.join("\n");
}

describe("CommandCategory drift-check", () => {
  test("the TypeScript enum and the zod schema hold the same set of categories", () => {
    const drift = describeCategoryDrift(Object.values(CommandCategory), [
      ...commandCategorySchema.options,
    ]);

    expect(drift).toBe("");
  });

  test("every CommandCategory value is accepted by commandCategorySchema", () => {
    // The registration-time path the drift actually breaks: each enum value must
    // survive the schema parse that `validateCommandDefinition` performs.
    for (const value of Object.values(CommandCategory)) {
      expect(commandCategorySchema.safeParse(value).success).toBe(true);
    }
  });
});

describe("CommandCategory drift-check — the check can fail (negative control)", () => {
  test("a value only in the enum is reported, naming the value and both files", () => {
    const drift = describeCategoryDrift(["CORE", "GIT", "ONLY_IN_ENUM"], ["CORE", "GIT"]);

    expect(drift).toContain("ONLY_IN_ENUM");
    expect(drift).toContain(TS_ENUM_PATH);
    expect(drift).toContain(ZOD_SCHEMA_PATH);
  });

  test("a value only in the schema is reported, naming the value and both files", () => {
    const drift = describeCategoryDrift(["CORE", "GIT"], ["CORE", "GIT", "ONLY_IN_SCHEMA"]);

    expect(drift).toContain("ONLY_IN_SCHEMA");
    expect(drift).toContain(TS_ENUM_PATH);
    expect(drift).toContain(ZOD_SCHEMA_PATH);
  });

  test("drift in both directions at once is reported together", () => {
    const drift = describeCategoryDrift(["CORE", "ONLY_IN_ENUM"], ["CORE", "ONLY_IN_SCHEMA"]);

    expect(drift).toContain("ONLY_IN_ENUM");
    expect(drift).toContain("ONLY_IN_SCHEMA");
  });

  test("agreeing sets report no drift regardless of declaration order", () => {
    // Load-bearing, not decorative: the two real lists declare MEMORY in
    // different positions, so an order-sensitive comparison would fail today.
    expect(describeCategoryDrift(["GIT", "CORE"], ["CORE", "GIT"])).toBe("");
  });
});
