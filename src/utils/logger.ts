#!/usr/bin/env bun
import * as winston from 'winston';

const { combine, timestamp, json, printf, colorize } = winston.format;

const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

// Agent Logger (Structured JSON to STDOUT)
export const agentLogger = winston.createLogger({
  level: LOG_LEVEL,
  format: combine(
    timestamp(),
    json(),
    winston.format.errors({ stack: true }) // Log stack traces for Error objects
  ),
  transports: [
    new winston.transports.Console({ // Default Console logs non-errors to stdout
      handleExceptions: true, // Log uncaught exceptions
      handleRejections: true, // Log unhandled rejections
    }),
  ],
  exitOnError: true, // Per robust-error-handling, exit on unhandled exceptions (Winston's default)
});

// Program Logger (Plain Text to STDERR)
export const programLogger = winston.createLogger({
  level: LOG_LEVEL,
  format: combine(
    colorize(),
    printf(info => String(info.message)) // Keep it simple: just the message, colorized by level implicitly
    // Levels like 'info:' will be prepended by winston if not customized away
    // For true minimality, ensure format is just `printf(info => String(info.message))`
    // But winston's default level prefix is usually fine.
    // Let's refine to ensure only message for CLI output:
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'], // Ensure all levels go to stderr
      handleExceptions: true, // Also catch exceptions here if they are specific to CLI interactions
      handleRejections: true,
    }),
  ],
  exitOnError: true,
});

// Refined programLogger format for truly minimal message-only output
programLogger.format = combine(
  colorize(),
  printf(info => `${String(info.message)}`) // Only the message, color applied by level
);


// Convenience log functions
export const log = {
  // Agent logs (structured)
  debug: (message: string, meta?: any) => agentLogger.debug(message, meta),
  info: (message: string, meta?: any) => agentLogger.info(message, meta),
  warn: (message: string, meta?: any) => agentLogger.warn(message, meta),
  error: (message: string | Error, meta?: any) => {
    // Winston's format.errors({ stack: true }) handles Error objects well
    agentLogger.error(message as string, meta); // Cast to string for the signature, error object is passed
  },

  // Program logs (plain text to stderr)
  cli: (message: string) => programLogger.info(message),
  cliWarn: (message: string) => programLogger.warn(message),
  cliError: (message: string) => programLogger.error(message),
  // For verbose CLI debugging, if needed:
  // cliDebug: (message: string) => programLogger.debug(message),
};

// Basic test to ensure it works - can be removed or moved to a test file
if (process.env.RUN_LOGGER_TEST === 'true') {
  console.log("--- Agent Logger (stdout) ---");
  log.debug("Agent debug message", { data: "some debug data" });
  log.info("Agent info message", { user: "test" });
  log.warn("Agent warning message", { code: 100 });
  log.error("Agent error message (string)", { details: "string error" });
  log.error(new Error("Agent error via Error object"), { custom: "meta" });

  console.log("\n--- Program Logger (stderr) ---");
  log.cli("This is a CLI message.");
  log.cliWarn("This is a CLI warning.");
  log.cliError("This is a CLI error.");

  // Example of an uncaught exception (uncomment to test exception handler)
  // setTimeout(() => {
  //   throw new Error("Test uncaught exception");
  // }, 100);
} 
