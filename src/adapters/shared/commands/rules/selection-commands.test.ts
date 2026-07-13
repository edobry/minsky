/**
 * Regression tests for the rules_enable / rules_disable param fix (mt#2741).
 *
 * The bug: these commands declared `ruleId` while the rules_* family (rules_get,
 * rules_create, rules_update) uses `id`. A caller following the family convention
 * passed `id`, which was dropped (required `ruleId` missing → error). The fix makes
 * `id` canonical and keeps `ruleId` as a back-compat alias, resolved by
 * `resolveRuleId` (throws when neither is supplied).
 *
 * These test `resolveRuleId` directly — the command handlers call `enableRule`/
 * `disableRule` (module imports that hit the real workspace), so the resolver is
 * the unit under test; it is the code path that decides which id reaches them.
 */

import { describe, test, expect } from "bun:test";
import { resolveRuleId } from "./selection-commands";
import { ValidationError } from "@minsky/domain/errors/index";

const RULE = "my-rule";

describe("resolveRuleId (mt#2741)", () => {
  test("resolves the canonical `id` param", () => {
    expect(resolveRuleId({ id: RULE, ruleId: undefined }, "rules.enable")).toBe(RULE);
  });

  test("resolves the legacy `ruleId` alias", () => {
    expect(resolveRuleId({ id: undefined, ruleId: RULE }, "rules.disable")).toBe(RULE);
  });

  test("prefers `id` when both are supplied", () => {
    expect(resolveRuleId({ id: RULE, ruleId: "other" }, "rules.enable")).toBe(RULE);
  });

  test("throws ValidationError when neither is supplied", () => {
    expect(() => resolveRuleId({ id: undefined, ruleId: undefined }, "rules.enable")).toThrow(
      ValidationError
    );
  });
});
