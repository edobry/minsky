/**
 * Test files the clock-shifted run skips, and why (mt#4726 SC4).
 *
 * This list is a deliverable in its own right: before it existed, the repo had no inventory of
 * where it deliberately couples to absolute time. Keep it small and keep every entry justified —
 * an unexplained entry is how a real bomb gets suppressed and looks handled.
 *
 * ## Two classes, and they age in opposite directions
 *
 * `intentional-time-coupling` is PERMANENT. The test genuinely asserts an absolute date, that is
 * correct, and moving the clock necessarily breaks it. Nothing is owed.
 *
 * `probe-artifact` is a DEBT against the shim, not a property of the test. The test is fine and
 * `clock-shift.ts` simply cannot represent its world — most often because it writes a file and
 * measures the file's age, and the shim moves the clock without moving filesystem timestamps.
 * Each entry names the task that would retire it. A single undifferentiated list would let these
 * accumulate inside what reads as an inventory of deliberate choices, which is why the classes are
 * separate rather than a free-text reason field.
 */

export type ClockShiftExemptionClass = "intentional-time-coupling" | "probe-artifact";

export interface ClockShiftExemption {
  /** Repo-relative path. Compared with leading `./` normalised away. */
  readonly file: string;
  readonly exemptionClass: ClockShiftExemptionClass;
  /** Why the shifted run cannot judge this file. One sentence, concrete. */
  readonly reason: string;
  /**
   * For `probe-artifact` only: the task that would let this entry be deleted. Required by
   * `assertExemptionsWellFormed`, so a debt cannot be filed without an owner.
   */
  readonly retiredBy?: string;
}

export const CLOCK_SHIFT_EXEMPTIONS: readonly ClockShiftExemption[] = [
  {
    file: "packages/domain/src/git/lock-operations.test.ts",
    exemptionClass: "probe-artifact",
    reason:
      "Writes a lock file with a fresh real mtime and asserts its age is under the staleness " +
      "threshold. Under a shifted clock the file reads as `offset` old, so the refusal it asserts " +
      "never happens. Real elapsed time would advance the mtime and the clock together; the shim " +
      "advances only the clock.",
    retiredBy: "mt#4726",
  },
];

/** Normalise a path for comparison: strip a leading `./` so both spellings match. */
export function normalizeExemptionPath(file: string): string {
  return file.startsWith("./") ? file.slice(2) : file;
}

/**
 * True when `file` is exempt from the shifted run.
 *
 * `exemptions` is an optional trailing parameter with a real default — the same injectable seam
 * shape `testing-standards.mdc §Testable Design` prescribes for the clock. It exists so a test can
 * exercise path matching against its own fixture instead of the committed list. Coupling a test to
 * the committed list would make it fail exactly when that list is EMPTIED, which is the state this
 * whole mechanism is trying to reach (PR #3487 R1).
 */
export function isClockShiftExempt(
  file: string,
  exemptions: readonly ClockShiftExemption[] = CLOCK_SHIFT_EXEMPTIONS
): boolean {
  const normalized = normalizeExemptionPath(file);
  return exemptions.some((e) => normalizeExemptionPath(e.file) === normalized);
}

/**
 * Fail loudly on a malformed list rather than silently skipping more than intended.
 *
 * Returns the problems rather than throwing, so both the runner and a unit test can use it.
 */
export function assertExemptionsWellFormed(
  exemptions: readonly ClockShiftExemption[] = CLOCK_SHIFT_EXEMPTIONS
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const entry of exemptions) {
    const normalized = normalizeExemptionPath(entry.file);
    if (seen.has(normalized)) {
      problems.push(`duplicate entry for ${entry.file}`);
    }
    seen.add(normalized);

    if (entry.reason.trim() === "") {
      problems.push(`${entry.file} has an empty reason`);
    }
    if (entry.exemptionClass === "probe-artifact" && !entry.retiredBy?.trim()) {
      problems.push(
        `${entry.file} is a probe-artifact exemption with no \`retiredBy\` task — a debt against ` +
          "the shim needs an owner, or it is indistinguishable from an intentional exemption"
      );
    }
  }

  return problems;
}
