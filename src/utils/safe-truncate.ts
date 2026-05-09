// Re-export from @minsky/shared. The canonical implementation now lives in
// the workspace shared package (mt#1681). This file is kept as a thin re-export
// so existing call sites under src/ don't need to update.
export { safeTruncate } from "@minsky/shared/safe-truncate";
