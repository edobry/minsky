/**
 * Parameter Mapper for CLI Bridge
 *
 * Maps shared command parameters with Zod schemas to Commander.js options.
 * Handles validation, type conversions, and help text generation.
 */

import { Command, Option } from "commander";
import { z } from "zod";
import type { CommandParameterDefinition } from "../command-registry";
import { paramNameToFlag } from "../schema-bridge";
import { getErrorMessage } from "@minsky/domain/errors/index";
import { formatZodError } from "@minsky/domain/schemas/validation-utils";

/**
 * Configuration options for parameter mapping
 */
export interface ParameterMappingOptions {
  /** Parameter alias (shorthand) */
  alias?: string;
  /** Override the parameter description */
  spec?: string;
  /** Human-readable description */
  description?: string;
  /** Override the default value */
  defaultValue?: unknown;
  /** Whether to hide this parameter from help */
  hidden?: boolean;
  /** Custom validation function */
  validator?: (value: unknown) => boolean;
  /** Custom error message for validation failures */
  errorMessage?: string;
  /** Custom parser for the value */
  parser?: (value: unknown) => unknown;
  /** Whether to handle this as a variadic parameter */
  variadic?: boolean;
  /** Whether to treat this as a CLI argument instead of option */
  asArgument?: boolean;
  /** Map this parameter to a different parameter in the command execution */
  mapTo?: string;
}

/**
 * Represents a parameter mapping with its definition and options
 */
export interface ParameterMapping {
  name: string;
  paramDef: CommandParameterDefinition;
  options: ParameterMappingOptions;
}

/**
 * Creates Commander.js options from parameter mappings
 */
export function createOptionsFromMappings(mappings: ParameterMapping[]): Option[] {
  return mappings.filter((mapping) => !mapping.options.asArgument).map(createOptionFromMapping);
}

/**
 * Adds Commander.js arguments from parameter mappings
 */
export function addArgumentsFromMappings(command: Command, mappings: ParameterMapping[]): Command {
  const argumentMappings = mappings.filter((mapping) => mapping.options.asArgument);

  argumentMappings.forEach((mapping) => {
    const { name, paramDef, options } = mapping;

    // Format argument name
    const argName = formatArgumentName(name, paramDef.required, options.variadic);

    // Add argument to command
    if (options.variadic) {
      command.argument(argName, options.description || paramDef.description || "");
    } else {
      command.argument(argName, options.description || paramDef.description || "");
    }

    // A custom `parser` is deliberately not attached here. Commander DOES accept
    // one on `.argument(name, description, fn)` — the comment this replaced
    // claimed otherwise, which is how positionals ended up with no coercion at
    // all (mt#1173). Parsing is centralized in `normalizeCliParameters` instead,
    // so a value is coerced against its zod schema wherever it arrives from,
    // not only when Commander declared the parser.
  });

  return command;
}

/**
 * Creates a Commander.js Option from a parameter mapping
 */
function createOptionFromMapping(mapping: ParameterMapping): Option {
  const { name, paramDef, options } = mapping;

  // Get schema type for proper option definition
  const schemaType = getZodSchemaType(paramDef.schema);

  // Format option flag
  const flag = formatOptionFlag(name, options.alias, schemaType);

  // Create the option
  const option = new Option(flag, options.description || paramDef.description || "");

  // Apply additional configuration
  if (options.hidden) {
    option.hideHelp();
  }

  if (paramDef.defaultValue !== undefined || options.defaultValue !== undefined) {
    option.default(options.defaultValue ?? paramDef.defaultValue);
  }

  // Add proper type handling based on schema
  addTypeHandlingToOption(option, schemaType, options.parser);

  return option;
}

/**
 * Format a Commander option flag
 */
function formatOptionFlag(name: string, alias?: string, schemaType?: string): string {
  let flag = "";

  // Add alias if provided
  if (alias) {
    flag += `-${alias}, `;
  }

  // Add main flag with kebab-case conversion
  flag += `--${paramNameToFlag(name)}`;

  // Add value placeholder for non-boolean types
  if (schemaType !== "boolean") {
    flag += ` <${schemaType || "value"}>`;
  }

  return flag;
}

/**
 * Format an argument name based on requirements
 */
function formatArgumentName(name: string, required: boolean, variadic?: boolean): string {
  let argName = name;

  // Make optional arguments appear in square brackets
  if (!required) {
    argName = `[${argName}]`;
  } else {
    argName = `<${argName}>`;
  }

  // Add ellipsis for variadic arguments
  if (variadic) {
    argName += "...";
  }

  return argName;
}

/**
 * Add type-specific handling to a Commander option
 */
function addTypeHandlingToOption(
  option: Option,
  schemaType?: string,
  customParser?: (value: unknown) => unknown
): Option {
  // If a custom parser is provided, use it
  if (customParser) {
    return option.argParser(customParser);
  }

  // Otherwise use schema type to determine parsing
  switch (schemaType) {
    case "number":
      return option.argParser((value) => {
        const num = Number(value);
        if (isNaN(num)) {
          throw new Error("Option requires a number value");
        }
        return num;
      });

    case "boolean":
      return option;

    case "array":
      return option.argParser((value) => value.split(",").map((v) => v.trim()));

    default:
      return option;
  }
}

/**
 * Try to determine the Zod schema type for appropriate option handling
 */
function getZodSchemaType(schema: z.ZodType): string | undefined {
  // Use Zod v4 .type property for schema type identification
  const schemaType = (schema as { type?: string }).type;

  // Handle primitive types
  if (schemaType === "string") return "string";
  if (schemaType === "number") return "number";
  if (schemaType === "boolean") return "boolean";

  // Handle arrays
  if (schemaType === "array") return "array";

  // Handle optional types and nullable types (unwrap and check inner type)
  if (schemaType === "optional" || schemaType === "nullable") {
    return getZodSchemaType((schema as z.ZodOptional | z.ZodNullable).unwrap() as z.ZodType);
  }

  // Handle default types (unwrap and check inner type)
  if (schemaType === "default") {
    return getZodSchemaType((schema as z.ZodDefault).removeDefault() as z.ZodType);
  }

  // Handle enums
  if (schemaType === "enum") return "string";

  // Default to string for other types
  return "string";
}

/**
 * Returns the underlying Zod v4 structured-type name ("record" | "object")
 * when the schema (after unwrapping optional / nullable / default) expects a
 * structured value that has no scalar CLI representation. Such a parameter
 * supplied on the CLI (`--flag '<json>'`) arrives as a raw JSON string and
 * must be `JSON.parse`d before schema validation.
 *
 * Scoped to record + object deliberately. Arrays are EXCLUDED: they have
 * established CLI multi-value conventions (repeated flags collected into an
 * array, comma-split argParsers, `z.union([string, array])` patterns), and
 * auto-JSON-parsing a bare string array value would regress those. Record and
 * object have no scalar CLI form, so a string value is unambiguously JSON.
 * (mt#2482)
 *
 * Wrapper handling (optional / nullable / default / refine / transform) moved
 * to `unwrappedZodType` below when mt#1173 gave it a second caller; see there
 * for the zod-v4 mechanics.
 */
function structuredZodType(schema: z.ZodType): "record" | "object" | undefined {
  const schemaType = unwrappedZodType(schema);
  return schemaType === "record" || schemaType === "object" ? schemaType : undefined;
}

/**
 * The innermost zod v4 type name, after unwrapping the wrappers a CLI parameter
 * can legitimately carry. Shared by `structuredZodType` and
 * `coerceScalarCliString` so both agree on what a schema actually expects.
 *
 * `optional` / `nullable` / `default` unwrap to the inner schema. `.refine()`
 * needs no case: checks are added in place, so the underlying `.type` survives.
 * `A.pipe(B)` and `X.transform()` are both `pipe`, and a CLI value must match
 * the INPUT side — so recurse into `.in`, the public ZodPipe input accessor in
 * zod v4. That is what keeps `record.transform(...)` detected as a record while
 * `string.pipe(...)` is correctly left alone (mt#2482 R1).
 *
 * Deliberately NOT shared with `getZodSchemaType` above, which drives Commander
 * option construction and has its own (separately-owned) gap for unions —
 * mt#3731. Merging them would entangle two independent defects.
 */
function unwrappedZodType(schema: z.ZodType): string | undefined {
  const schemaType = (schema as { type?: string }).type;
  if (schemaType === "optional" || schemaType === "nullable") {
    return unwrappedZodType((schema as z.ZodOptional | z.ZodNullable).unwrap() as z.ZodType);
  }
  if (schemaType === "default") {
    return unwrappedZodType((schema as z.ZodDefault).removeDefault() as z.ZodType);
  }
  if (schemaType === "pipe") {
    const inSchema = (schema as z.ZodPipe).in as z.ZodType | undefined;
    return inSchema ? unwrappedZodType(inSchema) : undefined;
  }
  return schemaType;
}

/**
 * Converts a CLI-supplied string to the scalar type its schema declares.
 *
 * Every CLI value arrives as a string, but a shared command declaring
 * `z.number()` rejects one — so a numeric POSITIONAL is unusable from the CLI
 * while the identical command works over MCP, which is JSON-typed (mt#1173).
 * Options escape this because `addTypeHandlingToOption` gives them a Commander
 * `argParser`; a positional gets no parser, so its raw string reaches
 * `schema.parse()` and fails with "expected number, received string".
 *
 * The conversion is deliberately NARROWER than zod's own `z.coerce.number()`,
 * which is documented to use `Number(input)` and therefore maps `true` to 1,
 * `null` to 0 and `""` to 0. Putting that on a registry schema would change the
 * MCP transport's semantics too, since both boundaries validate against the
 * same schema. So this converts only at the CLI boundary, only for STRING
 * input, and only when the string actually denotes a value of the target type.
 * A string that does not is returned UNTOUCHED, so zod raises its own error and
 * genuinely-malformed input keeps the message it has always had.
 *
 * Arrays and unions are excluded by construction: `unwrappedZodType` reports
 * them as "array"/"union", which matches no branch below. Their CLI handling is
 * a separate defect with a separate owner (mt#3731).
 */
function coerceScalarCliString(raw: string, schema: z.ZodType): string | number | bigint | boolean {
  const target = unwrappedZodType(schema);
  if (target !== "number" && target !== "bigint" && target !== "boolean") {
    return raw;
  }

  // `Number("")` is 0 and `BigInt("")` is 0n — an omitted-looking value must
  // never become a real one, so an empty/whitespace string is left to zod.
  const trimmed = raw.trim();
  if (trimmed === "") {
    return raw;
  }

  if (target === "number") {
    const parsed = Number(trimmed);
    // Rejects NaN and both infinities; `z.number()` refuses them anyway, and
    // returning the raw string produces the clearer type-level message.
    return Number.isFinite(parsed) ? parsed : raw;
  }

  if (target === "bigint") {
    return /^[+-]?\d+$/.test(trimmed) ? BigInt(trimmed) : raw;
  }

  const lowered = trimmed.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  return raw;
}

/**
 * Create parameter mappings from a CommandParameterMap
 */
export function createParameterMappings(
  parameters: Record<string, CommandParameterDefinition>,
  customOptions: Record<string, ParameterMappingOptions> = {}
): ParameterMapping[] {
  return Object.entries(parameters).map(([name, paramDef]) => ({
    name,
    paramDef,
    options: {
      // Apply default options
      hidden: paramDef.cliHidden,

      // Override with custom options if available
      ...customOptions[name],
    },
  }));
}

/**
 * Validates and normalizes CLI arguments to match shared command parameter expectations
 */
export function normalizeCliParameters(
  parametersSchema: Record<string, CommandParameterDefinition>,
  cliParameters: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Process each parameter
  for (const [paramName, paramDef] of Object.entries(parametersSchema)) {
    const rawValue = cliParameters[paramName];

    // Handle undefined values
    if (rawValue === undefined) {
      // mt#2705: consult the Zod schema FIRST via `safeParse(undefined)` so a
      // schema-embedded `.default(...)` is authoritative — mirrors the MCP
      // fix in `convertMcpArgsToParameters` (shared-command-integration.ts).
      // Previously only the sibling `defaultValue` field below was ever
      // consulted here, silently leaving a `.default(...)`-only parameter
      // `undefined` on the CLI path too.
      const schema = paramDef.schema as z.ZodTypeAny | undefined;
      const parsed =
        typeof schema?.safeParse === "function" ? schema.safeParse(undefined) : undefined;
      if (parsed?.success && parsed.data !== undefined) {
        result[paramName] = parsed.data;
        continue;
      }

      // Use default value if available. The `continue` matters (PR #2248 R1):
      // without it, a `required: true` param whose default resolved via the
      // sibling `defaultValue` field fell through to the throw below —
      // setting the default and then rejecting the call as "missing" anyway,
      // diverging from the MCP path (`convertMcpArgsToParameters`), which
      // returns the sibling default without throwing. A resolved default
      // (schema-level above, or sibling here) always short-circuits.
      if (paramDef.defaultValue !== undefined) {
        result[paramName] = paramDef.defaultValue;
        continue;
      }
      // Skip optional parameters
      if (!paramDef.required) {
        continue;
      }
      // Required, and NO default of any kind (schema OR sibling) resolved —
      // only then is the parameter genuinely missing.
      throw new Error(`Required parameter '${paramName}' is missing`);
    } else {
      // Record/object params have no scalar CLI representation: a `--flag
      // '<json>'` value arrives as a raw JSON string. JSON.parse it before
      // schema validation, otherwise `schema.parse("<string>")` fails with
      // "expected record, received string" (mt#2482). A non-string value
      // (e.g. an object passed via the in-process/MCP path) is left as-is.
      // Done OUTSIDE the validation try below so its error isn't re-wrapped.
      let valueToParse = rawValue;
      const structured = structuredZodType(paramDef.schema as z.ZodType);
      if (structured && typeof rawValue === "string") {
        try {
          valueToParse = JSON.parse(rawValue);
        } catch {
          throw new Error(
            `Invalid value for parameter '${paramName}': expected a JSON ${structured} ` +
              `(e.g. '{"key":"value"}'), but the value is not valid JSON: ${rawValue}`
          );
        }
      } else if (typeof rawValue === "string") {
        // Scalar sibling of the structured branch above: a CLI positional
        // reaches here as a raw string with no Commander parser to have typed
        // it, so coerce it against the declared scalar schema first (mt#1173).
        // A schema is either structured or scalar, never both, so `else if`
        // keeps the two mutually exclusive. Non-string values (the MCP and
        // in-process paths, and any option Commander already parsed) skip both.
        valueToParse = coerceScalarCliString(rawValue, paramDef.schema as z.ZodType);
      }

      // Parse and validate the value
      try {
        const parsedValue = paramDef.schema.parse(valueToParse);
        result[paramName] = parsedValue;
      } catch (error) {
        // Use user-friendly error formatting for Zod validation errors
        if (error instanceof z.ZodError) {
          const userFriendlyMessage = formatZodError(error, paramName);
          throw new Error(`Invalid value for parameter '${paramName}': ${userFriendlyMessage}`);
        } else {
          throw new Error(`Invalid value for parameter '${paramName}': ${getErrorMessage(error)}`);
        }
      }
    }
  }

  return result;
}
