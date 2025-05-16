#!/usr/bin/env bun
import winston, { format, transports } from 'winston';
import { TransformableInfo } from 'logform';

// Environment variable for log level
const logLevel = process.env.LOG_LEVEL || 'info';

// Common format for agent logs (JSON)
const agentLogFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }), // Log stack traces
  format.json()
);

// Common format for program/CLI logs (plain text)
const programLogFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf((info: TransformableInfo) => {
    // Ensure message is a string
    const message = typeof info.message === 'string' ? info.message : JSON.stringify(info.message);
    let log = `${info.timestamp} [${info.level}]: ${message}`;
    if (info.stack) {
      log += `\n${info.stack}`;
    }
    // Add other metadata if it exists
    const metadata = Object.keys(info).reduce((acc, key) => {
      if (['level', 'message', 'timestamp', 'stack'].includes(key)) {
        return acc;
      }
      acc[key] = info[key];
      return acc;
    }, {} as Record<string, any>);

    if (Object.keys(metadata).length > 0) {
      try {
        log += ` ${JSON.stringify(metadata)}`;
      } catch (e) {
        // ignore serialization errors for metadata in text logs
      }
    }
    return log;
  })
);

// Agent logger: structured JSON to stdout
const agentLogger = winston.createLogger({
  level: logLevel,
  format: agentLogFormat,
  transports: [new transports.Console({ stderrLevels: [] })], // Ensure only stdout
  exceptionHandlers: [new transports.Console({ format: agentLogFormat, stderrLevels: [] })],
  rejectionHandlers: [new transports.Console({ format: agentLogFormat, stderrLevels: [] })],
  exitOnError: false,
});

// Program logger: plain text to stderr
const programLogger = winston.createLogger({
  level: logLevel,
  format: programLogFormat,
  transports: [new transports.Console({ stderrLevels: ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'] })], // Ensure only stderr
  exceptionHandlers: [new transports.Console({ format: programLogFormat })],
  rejectionHandlers: [new transports.Console({ format: programLogFormat })],
  exitOnError: false,
});

interface LogContext {
  [key: string]: any;
}

// Convenience wrapper
export const log = {
  // Agent logs (structured JSON to stdout)
  agent: (message: string, context?: LogContext) => agentLogger.info(message, context),
  debug: (message: string, context?: LogContext) => agentLogger.debug(message, context),
  warn: (message: string, context?: LogContext) => agentLogger.warn(message, context),
  error: (message: string, context?: LogContext | Error | { originalError?: any; stack?: string; [key: string]: any; }) => {
    if (context instanceof Error) {
      agentLogger.error(message, { originalError: context.message, stack: context.stack, name: context.name });
    } else if (typeof context === 'object' && context !== null && (context.originalError || context.stack)) {
      agentLogger.error(message, context);
    }
     else {
      agentLogger.error(message, context);
    }
  },
  // Program/CLI logs (plain text to stderr)
  cli: (message: string, ...args: any[]) => programLogger.info(message, ...args),
  cliWarn: (message: string, ...args: any[]) => programLogger.warn(message, ...args),
  cliError: (message: string, ...args: any[]) => programLogger.error(message, ...args),
};

// Ensure logs are written before exiting on unhandled exceptions/rejections
const handleExit = async (error?: Error) => {
  if (error) {
    // Use programLogger for unhandled errors that might crash the CLI
    programLogger.error('Unhandled error or rejection, exiting.', error);
  }
  // Give logs a moment to flush
  await new Promise(resolve => setTimeout(resolve, 100));
};

process.on('uncaughtException', async (error) => {
  await handleExit(error);
  process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
  await handleExit(reason instanceof Error ? reason : new Error(String(reason)));
  process.exit(1);
});

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
