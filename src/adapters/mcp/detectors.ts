/**
 * MCP adapter for detector commands (attention-allocation noticer family).
 *
 * Surfaces `CommandCategory.DETECTORS` commands as MCP tools:
 *   - `unasked-direction.list` / `mark-real` / `mark-false-positive` (mt#1543)
 *   - `epic-decomposition.audit` (mt#1710)
 *
 * Follows the MEMORY single-path model — registered ONLY here, not also in
 * `registerAllMainCommandsWithMcp`. mt#1521 owns the broader source-of-truth
 * resolution that may apply this model to all categories. Until then the
 * MEMORY + DETECTORS pair are the documented single-path examples.
 *
 * Reference: src/adapters/mcp/validate.ts (sibling minimal adapter pattern)
 * Reference: src/adapters/mcp/memory.ts (sibling single-path adapter)
 * Reference: mt#1721 — task that filed this gap; reviewer-bot non-blocking
 *            finding on mt#1710 PR #1033 surfaced the issue.
 */

import type { CommandMapper } from "../../mcp/command-mapper";
import { registerDetectorsCommandsWithMcp } from "./shared-command-integration";

/**
 * Registers detector tools with the MCP command mapper.
 */
export function registerDetectorsTools(
  commandMapper: CommandMapper,
  container?: import("@minsky/domain/composition/types").AppContainerInterface
): void {
  registerDetectorsCommandsWithMcp(commandMapper, {
    container,
  });
}
