/**
 * Shared test utilities for rules/compile tests.
 */

import type { Rule } from "../types";

/** Create a minimal Rule object for tests. */
export function makeRule(id: string, content: string, opts: Partial<Rule> = {}): Rule {
  return {
    id,
    content,
    format: "cursor",
    path: `/fake/path/${id}.mdc`,
    alwaysApply: false,
    ...opts,
  };
}
