/**
 * Cold-start profiling utility for mt#1745.
 *
 * MOVED to `@minsky/shared/cold-start-profile` (mt#2973) so the domain /
 * persistence layer can emit checkpoints on the SAME module-singleton timeline
 * as `src/cli.ts` without importing from the app `src/` layer (a
 * clean-architecture violation). This file re-exports the canonical
 * implementation for the pre-existing app-layer importers (`src/cli.ts`,
 * `src/commands/mcp/start-command.ts`). Re-export (not copy) preserves the
 * single `PROFILE_START_MS` origin shared across both layers.
 */

export { profileCheckpoint, isProfileEnabled } from "@minsky/shared/cold-start-profile";
