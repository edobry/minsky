# md#414: Continue fixing failing tests and stabilize configuration writer via fs DI

## Status
- In progress

## Summary
- Refactored `src/domain/configuration/config-writer.ts` to support dependency injection for `fs` via a minimal `FsLike` interface.
- Updated `src/domain/configuration/config-writer.test.ts` to:
  - Create a fresh in-memory mock filesystem per test using `createMockFilesystem()`
  - Instantiate `ConfigWriter` with the per-test mock `fs` (no dynamic imports or module overrides)
- Began reconciling unset flows to ensure correct behavior and return values.

## Changes
- Added `FsLike` and optional `fsOverride` parameter to `ConfigWriter` constructor.
- Replaced direct `fs.*` calls with `this.fsImpl.*` in `ConfigWriter`.
- Removed dynamic `import()` and `mock.module()` usage from `config-writer.test.ts`; switched to DI with fresh per-test mocks.
- Intermediate progress on unset flows:
  - Preserving previous scalar value on unset for assertions
  - Planning to convert remaining `.mock(...)` reassignments to `.mockImplementation(...)` and ensure `existsSync` returns true where needed

## Rationale
- Aligns with no-dynamic-imports and per-test isolation patterns adopted across the suite.
- Improves test reliability by eliminating cross-test leakage and global module override behaviors.

## Next Steps
- Finalize unset tests by standardizing `.mockImplementation(...)` usage and ensuring positive paths set `existsSync` appropriately.
- Remove remaining references to `createConfigWriter` in tests or provide a thin factory that forwards the injected `fs`.
- Continue driving failing tests to green, then expand DI pattern to other modules as needed.
