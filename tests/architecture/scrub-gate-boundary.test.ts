/**
 * ADR-040 anti-drift check (mt#3268, AT1a / AT1b).
 *
 * The credential-scrub gate binds where transcript bytes CROSS the operator's
 * trust boundary, and not on an authenticated read. That decision is only
 * worth recording if something notices when a surface changes sides — and
 * per-endpoint status tests cannot notice it, because each asserts its own
 * surface in isolation. This file asserts the SET of call sites.
 *
 * AT1a — the authenticated-READ surfaces agree with each other: none calls
 * the gate. AT1b — the trust-boundary-CROSSING surfaces agree with each
 * other: all of them do. The two classes are deliberately NOT required to
 * agree with one another; that disagreement IS the decision, which is why the
 * task's earlier "same verdict from all three surfaces" phrasing was
 * corrected (PR #2984 R1).
 *
 * @see docs/architecture/adr-040-transcript-scrub-gate-binds-at-trust-boundary-crossings.md
 */
import { describe, expect, test } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed sources: which surfaces CALL the gate is a property of the committed files, not of injectable state; same exemption shape as tests/architecture/two-strikes-denial-wiring.test.ts
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "../..");

/** A CALL to the gate, not a doc-comment mention of its name. */
const GATE_CALL = /assertScrubGate\s*\(/;

/**
 * Surfaces that hand transcript bytes across the operator's trust boundary.
 * `gource-exporter.ts` both defines the gate and calls it from
 * `exportGourceLog`; `conversation-shares.ts` calls it through its injected
 * `assertScrubGate` dep at BOTH mint and public read.
 */
const CROSSING_SURFACES = [
  "packages/domain/src/transcripts/gource-exporter.ts",
  "src/cockpit/conversation-shares.ts",
] as const;

/**
 * Surfaces that render stored transcripts to an already-authenticated
 * operator. These must NOT call the gate.
 */
const AUTHENTICATED_READ_SURFACES = [
  "src/cockpit/routes/session-film.ts",
  "src/cockpit/routes/context-inspector.ts",
] as const;

function sourceOf(relPath: string): string {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same exemption as the import: these assertions ARE about the committed files, so there is no injectable state to fake
  return readFileSync(join(REPO_ROOT, relPath), "utf-8") as string;
}

describe("ADR-040 — the scrub gate binds at trust-boundary crossings only", () => {
  test("AT1b: every trust-boundary-crossing surface calls the gate", () => {
    const withoutGate = CROSSING_SURFACES.filter((p) => !GATE_CALL.test(sourceOf(p)));
    expect(withoutGate).toEqual([]);
  });

  test("AT1a: no authenticated-read surface calls the gate", () => {
    const withGate = AUTHENTICATED_READ_SURFACES.filter((p) => GATE_CALL.test(sourceOf(p)));
    expect(withGate).toEqual([]);
  });

  test("conversation-shares gates BOTH the mint and the public read, not just one", () => {
    const src = sourceOf("src/cockpit/conversation-shares.ts");
    const callCount = src.match(/assertScrubGate\s*\(/g)?.length ?? 0;
    // One in the `POST /api/shares` handler, one in `GET /api/shares/public/:token`.
    // A share minted before a gate change must not become readable after one.
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test("the gate's doc comment names its governed surfaces, so the set stays discoverable", () => {
    // SC3: the next consumer should not have to grep call sites. If this fails,
    // a surface changed sides without the doc comment following it.
    const doc = sourceOf("packages/domain/src/transcripts/gource-exporter.ts");
    expect(doc).toContain("adr-040-transcript-scrub-gate-binds-at-trust-boundary-crossings");
    expect(doc).toContain("conversation-shares.ts");
  });
});

/**
 * NOT covered, stated so this check is not mistaken for more than it is: a NEW
 * transcript-reading surface added tomorrow appears in neither list above, so
 * nothing here fires for it. The lists are the unit of maintenance — adding a
 * surface means classifying it here. The set cannot be derived automatically,
 * because "reads stored transcripts" is a semantic property, not a syntactic
 * one.
 */
export const KNOWN_TRANSCRIPT_SURFACES = [
  ...CROSSING_SURFACES,
  ...AUTHENTICATED_READ_SURFACES,
] as const;
