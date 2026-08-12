/**
 * Tests for `maskShape` (mt#4022 criterion 2 — the second, unrelated masking
 * convention this repo carries alongside `maskConnectionString`).
 *
 * `deploy-minsky-mcp.ts`'s `main()` is guarded by `import.meta.main` so this
 * file can import it without triggering a CLI run / `process.exit()`.
 */

import { describe, test, expect } from "bun:test";

import { maskShape } from "./deploy-minsky-mcp";
import { CREDENTIAL_SHAPES } from "../packages/domain/src/transcripts/credential-scrubber";

function matchesAnyShape(text: string): string | undefined {
  for (const shape of CREDENTIAL_SHAPES) {
    shape.regex.lastIndex = 0;
    if (shape.regex.test(text)) {
      return shape.name;
    }
  }
  return undefined;
}

describe("maskShape (mt#4022 criterion 2)", () => {
  test("every documented output form is a non-hit against CREDENTIAL_SHAPES", () => {
    const samples = [
      maskShape(undefined),
      maskShape("-----BEGIN RSA PRIVATE KEY-----\nfakefakefakefake\n-----END RSA PRIVATE KEY-----"),
      maskShape("5432"),
      maskShape("production"),
      maskShape("development"),
      maskShape("a totally ordinary secret value that is definitely not a url"),
      maskShape(""),
    ];

    for (const sample of samples) {
      const hit = matchesAnyShape(sample);
      expect(hit).toBeUndefined();
    }
  });

  test("outputs never contain a scheme + '://' — the structural reason no shape can ever match", () => {
    const samples = [
      maskShape(undefined),
      maskShape("5432"),
      maskShape("production"),
      maskShape("a totally ordinary secret value"),
    ];
    for (const sample of samples) {
      expect(sample).not.toContain("://");
    }
  });
});
