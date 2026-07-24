/**
 * @fileoverview Tests for custom/no-direct-service-construction.
 *
 * Two independent checks live in this rule:
 *
 * 1. The original named-list check (mt#911): `new TaskGraphService(...)` /
 *    `createConfiguredTaskService(...)` in the adapter layer (`/src/adapters/`).
 * 2. The DI-fallback-shape check (mt#2642, generalizing ADR-026 rule 3): the shape
 *    `<identifier> ?? create<PascalCase>(...)` and `<identifier>?.<prop> ?? new
 *    <PascalCase>(...)` across `src/` and `packages/domain/src/`.
 *
 * Decision record: docs/architecture/adr-026-dependency-injection-convention.md
 */

// eslint-disable-next-line no-restricted-imports -- ESLint rule tests must use .js extension for direct rule loading
import rule from "./no-direct-service-construction.js";
import { RuleTester } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(path.join(here, "__fixtures__", "no-direct-service-construction", name), "utf-8");

// Files exercising the DI-fallback-shape check (mt#2642). Deliberately NOT under
// `/src/adapters/` so the pre-existing named-list check (mt#911) stays inactive and the two
// checks don't interact in these cases.
const domainFile = "src/domain/example-service.ts";
const packagesDomainFile = "packages/domain/src/repository/example.ts";
// Sibling package with its own `src/` — out of the DI-fallback check's scope (mt#2642 targets
// only repo-root `src/` and `packages/domain/src/`, not `packages/shared/src/` etc.).
const outOfScopeFile = "packages/shared/src/example.ts";
const testFile = "src/domain/example.test.ts";

// Files exercising the original named-list check (mt#911) — adapter layer only. Leading
// slash matters here: the check is `normalizedFilename.includes("/src/adapters/")`, which
// (unlike the new isInFallbackScope() helper) is not leading-slash-agnostic — real ESLint
// runs always supply an absolute path, so this mirrors production.
const adapterFile = "/repo/src/adapters/shared/commands/tasks/example-command.ts";

const MSG_DIRECT_CONSTRUCTION = "directConstruction";
const MSG_DIRECT_FACTORY = "directFactoryCall";
const MSG_FALLBACK_CREATE = "diFallbackCreate";
const MSG_FALLBACK_NEW = "diFallbackNew";

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

tester.run("no-direct-service-construction", rule, {
  valid: [
    // --- DI-fallback-shape check (mt#2642) ---

    // Required (non-optional) `deps` parameter — no `??` fallback present at all.
    {
      filename: domainFile,
      code: `function make(deps: { client: Client }) { return deps.client; }`,
    },
    // Non-optional member access before `new <PascalCase>(...)` — needs `?.` for shape 2.
    {
      filename: domainFile,
      code: `function make(deps: { widget?: Widget }) { return deps.widget ?? new Widget(); }`,
    },
    // Plain default value — right side is neither `create<PascalCase>()` nor `new <PascalCase>()`.
    {
      filename: domainFile,
      code: `function withDefault(x?: number) { return x ?? 0; }`,
    },
    // `create` factory with a lowercase start does not match the naming convention.
    {
      filename: domainFile,
      code: `const client = x ?? createclient();`,
    },
    // Well-known built-in value constructors (Date, Map, Set, ...) are excluded from shape 2 —
    // these are ordinary default-value idioms (e.g. "current time unless overridden"), not the
    // service-construction anti-pattern this rule targets.
    {
      filename: packagesDomainFile,
      code: `const now = options?.now ?? new Date();`,
    },
    // Outside the rule's src/ + packages/domain/src/ scope (sibling package).
    {
      filename: outOfScopeFile,
      code: `const client = x ?? createConfiguredY();`,
    },
    // Test files are exempt from both checks.
    {
      filename: testFile,
      code: `const client = x ?? createConfiguredY();`,
    },
    // Full valid fixture.
    {
      filename: packagesDomainFile,
      code: fixture("valid.ts"),
    },

    // --- Named-list check (mt#911), unaffected by the mt#2642 addition ---

    // Non-banned identifier construction in the adapter layer.
    {
      filename: adapterFile,
      code: `const svc = new SomeOtherService();`,
    },
  ],

  invalid: [
    // --- DI-fallback-shape check (mt#2642) ---

    // Shape 1: `<identifier> ?? create<PascalCase>(...)`
    {
      filename: domainFile,
      code: `const client = x ?? createConfiguredY();`,
      errors: [{ messageId: MSG_FALLBACK_CREATE }],
    },
    // Shape 2: `<identifier>?.<prop> ?? new <PascalCase>(...)`
    {
      filename: packagesDomainFile,
      code: `const widget = x?.y ?? new Z();`,
      errors: [{ messageId: MSG_FALLBACK_NEW }],
    },
    // Full invalid fixture — one instance of each shape.
    {
      filename: packagesDomainFile,
      code: fixture("invalid.ts"),
      errors: [{ messageId: MSG_FALLBACK_CREATE }, { messageId: MSG_FALLBACK_NEW }],
    },

    // --- Named-list check (mt#911) ---

    {
      filename: adapterFile,
      code: `const svc = new TaskGraphService();`,
      errors: [{ messageId: MSG_DIRECT_CONSTRUCTION }],
    },
    {
      filename: adapterFile,
      code: `const svc = createConfiguredTaskService();`,
      errors: [{ messageId: MSG_DIRECT_FACTORY }],
    },
  ],
});

console.log("no-direct-service-construction: all rule-tester cases pass");
