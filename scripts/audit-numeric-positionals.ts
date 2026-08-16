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

/**
 * Whether the schema coerces a CLI string on its own — i.e. carries a
 * `z.coerce.*` that makes the command work from the CLI regardless of the
 * adapter. Worth flagging: such a schema HIDES the gap rather than not having
 * it, which is exactly what mt#1170 did and what let the defect recur three
 * more times before mt#1173 fixed it structurally.
 *
 * Detected BEHAVIOURALLY, through zod's public parse API, by asking whether a
 * string gets PAST THE TYPE CHECK — not whether it parses cleanly.
 *
 * The distinction is load-bearing. Zod runs the type check first and only then
 * the refinements, so on a string input:
 *
 *   - a NON-coercing schema always fails with an `invalid_type` issue, and its
 *     refinements never run at all;
 *   - a COERCING schema either succeeds, or fails on a refinement with some
 *     OTHER code (`too_small`, `custom`, ...) — never `invalid_type`.
 *
 * So "no `invalid_type` issue" is exactly "the value was coerced". Verified
 * total over 14 shapes on zod 4.4.3: `{number, bigint}` x `{bare, .min(),
 * .int().positive(), .optional(), .default(), .refine()}`, coercing and plain.
 *
 * Testing `success` alone would be wrong, and was: `z.coerce.number().min(10)`
 * coerces `"1"` perfectly well and then rejects it as `too_small`, so a
 * success-only predicate calls a coercing schema plain (PR #3011 R1). Because
 * the discriminator is the issue CODE, the probe value no longer has to satisfy
 * anyone's bounds — `"1"` need only be a string that coerces, which for a
 * numeric target it is.
 *
 * The earlier implementation read the private `coerce` flag hanging off the
 * schema's internal def object instead, which had a live false negative rather
 * than merely a future-fragility risk (mt#4163): that flag lives on the
 * OUTERMOST schema, and `.optional()` / `.default()` build a wrapper whose own
 * internals carry no `coerce`. (Spelled in prose deliberately — the underscore
 * -prefixed accessor is greppable, and mt#4163's first acceptance test is a
 * repo grep for private-internals access that a mention would otherwise trip.)
 * Measured on
 * zod 4.4.3, `z.coerce.number().optional()` and `z.coerce.number().default(5)`
 * both read `false` — the flag went silent on precisely the masking case it
 * exists to catch, and on the same row where `unwrappedType` had just seen
 * THROUGH those wrappers to find the param. The two halves of one line
 * disagreed. `.refine()` was unaffected: it adds checks in place with no
 * wrapper (the zod-v4 fact mt#1173's tests pin).
 */
function isSelfCoercing(schema: unknown): boolean {
  const parsed = (schema as z.ZodType | undefined)?.safeParse?.("1");
  if (!parsed) return false;
  if (parsed.success) return true;
  return !parsed.error.issues.some((issue) => issue.code === "invalid_type");
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
      selfCoercing: isSelfCoercing(def.schema),
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
