/**
 * Tests for the callable credential-shape check (mt#4022).
 *
 * All credential values below are SYNTHETIC — shaped to match the regex
 * (correct prefix/length/charset) but not derived from, and unrelated to,
 * any real credential from any incident or config file. Never paste a real
 * leaked shape into a test.
 */

import { describe, test, expect } from "bun:test";

import { checkForUnmaskedCredentials } from "./credential-shape-check";
import { maskConnectionString } from "../persistence/connection-string";
import { CREDENTIAL_SHAPES } from "../transcripts/credential-scrubber";

// A synthetic, obviously-fake connection string — never a real credential.
const FAKE_UNMASKED_PG_URL = "postgresql://fakeuser:fakepassword@db.example.invalid:5432/mydb";

// The one shape name every AT in this file exercises — extracted once to
// satisfy the no-magic-string-duplication lint rule.
const POSTGRES_URL_SHAPE = "postgres-url-credentials";

describe("checkForUnmaskedCredentials (mt#4022)", () => {
  test("empty / non-string input is clean, never throws", () => {
    expect(checkForUnmaskedCredentials("")).toEqual({
      hasUnmaskedCredential: false,
      matchedShapes: [],
    });
  });

  test("ordinary text with no credential shape is clean", () => {
    const result = checkForUnmaskedCredentials("just a normal sentence with no secrets in it");
    expect(result.hasUnmaskedCredential).toBe(false);
    expect(result.matchedShapes).toEqual([]);
  });

  // AT1: synthetic unmasked postgresql://u:p@h/db -> hit, and the result
  // object never carries the matched text itself (only the shape name).
  test("AT1: synthetic unmasked postgresql:// URL is a hit, and no matched text is returned", () => {
    const result = checkForUnmaskedCredentials(FAKE_UNMASKED_PG_URL);
    expect(result.hasUnmaskedCredential).toBe(true);
    expect(result.matchedShapes).toEqual([POSTGRES_URL_SHAPE]);

    // The result must never carry the credential text itself, anywhere.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("fakeuser");
    expect(serialized).not.toContain("fakepassword");
  });

  // AT2: the mem#972 false-positive regression. `bun run db:migrate`'s own
  // output masks connection strings via `maskConnectionString` before
  // printing — this is what that rendering looks like. It must NOT be a hit.
  test("AT2 (mem#972 regression): real db:migrate-shaped masked output is NOT a hit", () => {
    const migrateOutput = [
      "=== bun run db:migrate ===",
      "Connecting to postgresql://***:***@db.internal.example:5432/minsky",
      "Applying pending migrations...",
      "Migration status: up to date (47 applied)",
    ].join("\n");

    const result = checkForUnmaskedCredentials(migrateOutput);
    expect(result.hasUnmaskedCredential).toBe(false);
    expect(result.matchedShapes).toEqual([]);
  });

  // AT3: the mem#808 false-negative regression. Both the `postgres://` and
  // `postgresql://` spellings of a REAL (unmasked) credential must hit.
  test("AT3 (mem#808 regression): both postgres:// and postgresql:// unmasked pairs hit", () => {
    const postgresScheme = checkForUnmaskedCredentials(
      "postgres://fakeuser:fakepassword@db.example.invalid:5432/mydb"
    );
    const postgresqlScheme = checkForUnmaskedCredentials(
      "postgresql://fakeuser:fakepassword@db.example.invalid:5432/mydb"
    );

    expect(postgresScheme.hasUnmaskedCredential).toBe(true);
    expect(postgresScheme.matchedShapes).toEqual([POSTGRES_URL_SHAPE]);
    expect(postgresqlScheme.hasUnmaskedCredential).toBe(true);
    expect(postgresqlScheme.matchedShapes).toEqual([POSTGRES_URL_SHAPE]);
  });

  // Criterion 2 sanity: maskConnectionString's own idempotency is what the
  // exclusion relies on — assert it directly against the real function
  // rather than assuming it.
  test("maskConnectionString is idempotent on its own output (the property the exclusion relies on)", () => {
    const masked = maskConnectionString(FAKE_UNMASKED_PG_URL);
    expect(masked).toBe("postgresql://***:***@db.example.invalid:5432/mydb");
    expect(maskConnectionString(masked)).toBe(masked);
  });

  test("a mixed blob with both a masked and an unmasked instance reports exactly the unmasked one", () => {
    const blob = [
      "already redacted: postgresql://***:***@safe.example/db",
      `still live: ${FAKE_UNMASKED_PG_URL}`,
    ].join("\n");
    const result = checkForUnmaskedCredentials(blob);
    expect(result.hasUnmaskedCredential).toBe(true);
    expect(result.matchedShapes).toEqual([POSTGRES_URL_SHAPE]);
  });

  test("other credential shapes (unrelated to the postgres-url masking collision) still hit", () => {
    const fakePulumiToken = `pul-${"a1b2c3d4".repeat(5)}`; // 40 hex chars
    const result = checkForUnmaskedCredentials(`export PULUMI_ACCESS_TOKEN=${fakePulumiToken}`);
    expect(result.hasUnmaskedCredential).toBe(true);
    expect(result.matchedShapes).toEqual(["pulumi-token"]);
  });

  // AT5: negative control. With the masked-form exclusion in place, AT2's
  // fixture must be clean (asserted above). This test documents — and
  // exercises — the OPPOSITE direction: feeding the exclusion's own basis
  // (an already-masked span) through the shape regex directly, without the
  // exclusion, reproduces mem#972's false positive. This is what was
  // manually reverted (commenting out the `MASKED_FORM_CHECKS` lookup) to
  // observe this suite's AT2 test fail before the fix — see the PR body's
  // negative-control section for that run's output.
  test("AT5 basis: the raw shape regex alone (no exclusion) DOES match the masked rendering", () => {
    const shape = CREDENTIAL_SHAPES.find((s) => s.name === POSTGRES_URL_SHAPE);
    if (!shape) throw new Error("postgres-url-credentials shape not found");
    shape.regex.lastIndex = 0;
    const maskedRendering = "postgresql://***:***@db.internal.example:5432/minsky";
    // This is exactly mem#972: the vetted shape regex, used alone, matches
    // the mask. checkForUnmaskedCredentials must (and does, per AT2 above)
    // exclude this case — this assertion documents WHY the exclusion exists.
    expect(shape.regex.test(maskedRendering)).toBe(true);
  });
});
