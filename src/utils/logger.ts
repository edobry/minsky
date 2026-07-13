// Re-export from @minsky/shared. The canonical implementation now lives in
// the workspace shared package. This file is kept as a thin re-export
// so existing call sites under src/ don't need to update.
export {
  LogMode,
  getLogMode,
  createLogger,
  createConfigurableLogger,
  log,
  isStructuredMode,
  isHumanMode,
  _resetDefaultLoggerForTests,
} from "@minsky/shared/logger";
export type { LoggerConfig, LogContext } from "@minsky/shared/logger";
