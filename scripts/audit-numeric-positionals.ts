#!/usr/bin/env bun
/**
 * Numeric-CLI-positional audit (mt#1173).
 *
 * Enumerates every command in the shared command registry and reports the ones
 * whose CLI POSITIONAL is numeric — i.e. whose first `required` parameter
 * declares `number` or `bigint`, since that is the slot
 * `useFirstRequiredParamAsArgument` promotes to a Commander argument
 * (`src/adapters/shared/bridges/cli/parameter-processor.ts`).
 *
 * Background: every CLI value arrives as a string, and until mt#1173 nothing
 * coerced a positional before `schema.parse()` — so a numeric positional failed
 * with "expected number, received string" while the identical command worked
 * over MCP. Options were unaffected: `addTypeHandlingToOption` gives them a
 * Commander `argParser`. This script is the live enumeration of the affected
 * set; it is what makes "all numeric positionals are covered" checkable rather
 * than asserted, and it reports a NEW one the moment a command adds it.
 *
 * The companion regression test
 * (`src/adapters/shared/bridges/parameter-mapper.test.ts`) pins the coercion
 * behaviour itself. This script answers the different question of WHICH
 * commands depend on it.
 *
 * Usage:
 *   bun scripts/audit-numeric-positionals.ts           # human-readable report
 *   bun scripts/audit-numeric-positionals.ts --json    # machine-readable
 */
import "reflect-metadata";
import { z } from "zod";
import { registerAllSharedCommands } from "../src/adapters/shared/commands/index";
import { sharedCommandRegistry } from "../src/adapters/shared/command-registry";

/**
 * Innermost zod v4 type name, unwrapping the wrappers a CLI parameter can carry.
 *
 * Mirrors `unwrappedZodType` in `parameter-mapper.ts` deliberately rather than
 * importing it: that one is module-private, and a copy here means this audit
 * keeps reporting the true registry shape even if the adapter's own unwrapping
 * regresses. A shared helper would make the audit agree with the bug.
 */
function unwrappedType(schema: unknown): string | undefined {
  const type = (schema as { type?: string } | undefined)?.type;
  if (type === "optional" || type === "nullable") {
    return unwrappedType((schema as z.ZodOptional).unwrap());
  }
  if (type === "default") {
    return unwrappedType((schema as z.ZodDefault).removeDefault());
  }
  if (type === "pipe") {
    const input = (schema as z.ZodPipe).in;
    return input ? unwrappedType(input) : undefined;
  }
  return type;
}

interface NumericPositional {
  commandId: string;
  param: string;
  declaredType: string;
  /** True when the schema carries its own `z.coerce`, masking the adapter gap. */
  selfCoercing: boolean;
}

await registerAllSharedCommands();
const commands = sharedCommandRegistry.getAllCommands();

const positionals: NumericPositional[] = [];
let numericParamsAnywhere = 0;

for (const command of commands) {
  const params = Object.entries(command.parameters ?? {});
  const firstRequired = params.find(([, def]) => def.required);

  for (const [name, def] of params) {
    const declaredType = unwrappedType(def.schema);
    if (declaredType !== "number" && declaredType !== "bigint") continue;
    numericParamsAnywhere++;

    if (firstRequired?.[0] !== name) continue;
    positionals.push({
      commandId: command.id,
      param: name,
      declaredType,
      // A `z.coerce.*` schema parses a string on its own, so the command works
      // from the CLI regardless of the adapter — worth flagging, because it
      // hides the gap rather than not having it (mt#1170 did exactly this).
      selfCoercing: Boolean(
        (def.schema as { _zod?: { def?: { coerce?: boolean } } })?._zod?.def?.coerce
      ),
    });
  }
}

positionals.sort((a, b) => a.commandId.localeCompare(b.commandId));

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        totalCommands: commands.length,
        numericParamsAnywhere,
        numericPositionals: positionals,
      },
      null,
      2
    )
  );
} else {
  console.log(`Commands in registry:            ${commands.length}`);
  console.log(`Numeric params (any position):   ${numericParamsAnywhere}`);
  console.log(`Numeric CLI positionals:         ${positionals.length}`);
  console.log("");
  for (const entry of positionals) {
    const note = entry.selfCoercing ? "  [schema self-coerces]" : "";
    console.log(`  ${entry.commandId}  ${entry.param} (${entry.declaredType})${note}`);
  }
  console.log("");
  console.log(
    "Each of the above relies on `normalizeCliParameters`' scalar coercion (mt#1173)\n" +
      "to accept its Commander-supplied string. Options are unaffected — they get a\n" +
      "Commander argParser from `addTypeHandlingToOption`."
  );
}
