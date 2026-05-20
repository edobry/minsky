/**
 * Deployment-platform abstraction entry point.
 *
 * Importing this module registers all built-in adapters (currently: Railway)
 * with the adapter registry. Subsequent calls to `resolveAdapter()` will find
 * them.
 *
 * See docs/deployment-platforms.md for the design.
 *
 * Tracking task: mt#1730.
 */

// Side-effect imports register adapters with the registry.
import "./railway";

export * from "./config";
export * from "./registry";
export * from "./service-resolver";
export * from "./types";
