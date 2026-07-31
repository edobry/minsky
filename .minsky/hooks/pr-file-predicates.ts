// Shared PR-file predicates — dependency-free by design (mt#3244).
//
// `isTestFile` used to live in `require-execution-evidence-before-merge.ts`. It moved
// here when `test-first-evidence.ts` needed it too: importing it from the evidence hook
// would have created an ESM cycle, because that hook imports the calibration surfaces
// (PR #2462 R1). This module imports NOTHING, so any hook module can consume it without
// a cycle — the same reasoning `success-criteria-coverage.ts` records in its own
// "Why this module does not import the evidence hook" section.
//
// The evidence hook re-exports `isTestFile` from here, so its existing callers and tests
// are unaffected by the move.
//
// @see .minsky/hooks/require-execution-evidence-before-merge.ts — re-exports this
// @see .minsky/hooks/test-first-evidence.ts — the second consumer that motivated the move

/**
 * Pattern for test files we care about. Matches:
 *   - *.test.ts
 *   - *.integration.test.ts
 *   - *.spec.ts
 */
const TEST_FILE_PATTERN = /\.(test|integration\.test|spec)\.ts$/;

/**
 * Returns true when a filename matches a test-file pattern.
 */
export function isTestFile(filename: string): boolean {
  return TEST_FILE_PATTERN.test(filename);
}
