// Re-export from @minsky/shared. The canonical implementation now lives in
// the workspace shared package. This file is kept as a thin re-export
// so existing call sites under src/ don't need to update.
export {
  DEFAULT_DEV_PORT,
  BYTES_PER_KB,
  HTTP_OK,
  MINUTE_IN_SECONDS,
  DEFAULT_TIMEOUT_MS,
} from "@minsky/shared/constants";
