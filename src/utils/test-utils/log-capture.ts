/**
 * Utilities for capturing logs in tests
 */

import * as winston from "winston";
import { Writable } from "stream";
import { log } from "../logger";

// Capture agent logs (stdout)
export interface CapturedAgentLog {
  level: string;
  message: string;
  context?: Record<string, any>;
  timestamp?: string;
}

// Capture CLI logs (stderr)
export interface CapturedCliLog {
  message: string;
  isError?: boolean;
  isWarning?: boolean;
}

/**
 * Create a log capture utility for testing
 * This replaces the transport while testing and restores it after
 */
export class LogCapture {
  private capturedAgentLogs: CapturedAgentLog[] = [];
  private capturedCliLogs: CapturedCliLog[] = [];
  
  private originalAgentTransports: winston.transport[];
  private originalCliTransports: winston.transport[];
  
  private mockAgentTransport: winston.transport;
  private mockCliTransport: winston.transport;
  
  constructor() {
    // Access the internal loggers
    const agentLogger = (log as any).agentLogger;
    const programLogger = (log as any).programLogger;
    
    if (!agentLogger || !programLogger) {
      throw new Error("Cannot access internal loggers - log capture not possible");
    }
    
    // Store original transports
    this.originalAgentTransports = [...agentLogger.transports];
    this.originalCliTransports = [...programLogger.transports];
    
    // Create mock transports
    this.mockAgentTransport = new winston.transports.Stream({
      stream: new Writable({
        write: (info: string) => {
          try {
            const parsed = JSON.parse(info);
            this.capturedAgentLogs.push({
              level: parsed.level,
              message: parsed.message,
              context: parsed.context || undefined,
              timestamp: parsed.timestamp
            });
          } catch (e) {
            // If parsing fails, store the raw string
            this.capturedAgentLogs.push({
              level: "unknown",
              message: info,
            });
          }
          return true;
        }
      })
    });
    
    this.mockCliTransport = new winston.transports.Stream({
      stream: new Writable({
        write: (info: string) => {
          try {
            const parsed = JSON.parse(info);
            this.capturedCliLogs.push({
              message: parsed.message,
              isError: parsed.level === "error",
              isWarning: parsed.level === "warn",
            });
          } catch (e) {
            // If parsing fails, store the raw string
            this.capturedCliLogs.push({
              message: info.trim()
            });
          }
          return true;
        }
      })
    });
  }
  
  /**
   * Start capturing logs
   */
  start(): void {
    // Access the internal loggers
    const agentLogger = (log as any).agentLogger;
    const programLogger = (log as any).programLogger;
    
    // Clear existing transports
    agentLogger.clear();
    programLogger.clear();
    
    // Add our mock transports
    agentLogger.add(this.mockAgentTransport);
    programLogger.add(this.mockCliTransport);
    
    // Reset captured logs
    this.capturedAgentLogs = [];
    this.capturedCliLogs = [];
  }
  
  /**
   * Stop capturing logs and restore original transports
   */
  stop(): void {
    // Access the internal loggers
    const agentLogger = (log as any).agentLogger;
    const programLogger = (log as any).programLogger;
    
    // Remove mock transports
    agentLogger.remove(this.mockAgentTransport);
    programLogger.remove(this.mockCliTransport);
    
    // Restore original transports
    this.originalAgentTransports.forEach(transport => {
      agentLogger.add(transport);
    });
    
    this.originalCliTransports.forEach(transport => {
      programLogger.add(transport);
    });
  }
  
  /**
   * Get captured agent logs (stdout)
   */
  getAgentLogs(): CapturedAgentLog[] {
    return [...this.capturedAgentLogs];
  }
  
  /**
   * Get captured CLI logs (stderr)
   */
  getCliLogs(): CapturedCliLog[] {
    return [...this.capturedCliLogs];
  }
  
  /**
   * Clear all captured logs
   */
  clear(): void {
    this.capturedAgentLogs = [];
    this.capturedCliLogs = [];
  }
  
  /**
   * Check if an agent log exists that matches the pattern
   * @param level The log level to match
   * @param messagePattern A substring or regex to match against the message
   * @param contextCheck Optional function to validate the context object
   */
  hasAgentLog(
    level: string, 
    messagePattern: string | RegExp, 
    contextCheck?: (context: Record<string, any> | undefined) => boolean
  ): boolean {
    return this.capturedAgentLogs.some(log => {
      const levelMatches = log.level === level;
      const messageMatches = typeof messagePattern === "string" 
        ? log.message.includes(messagePattern)
        : messagePattern.test(log.message);
      
      if (!levelMatches || !messageMatches) return false;
      
      if (contextCheck && log.context) {
        return contextCheck(log.context);
      }
      
      return contextCheck ? false : true;
    });
  }
  
  /**
   * Check if a CLI log exists that matches the pattern
   * @param messagePattern A substring or regex to match against the message
   * @param isError Whether to match error logs specifically
   * @param isWarning Whether to match warning logs specifically
   */
  hasCliLog(
    messagePattern: string | RegExp,
    isError?: boolean,
    isWarning?: boolean
  ): boolean {
    return this.capturedCliLogs.some(log => {
      const messageMatches = typeof messagePattern === "string"
        ? log.message.includes(messagePattern)
        : messagePattern.test(log.message);
      
      if (!messageMatches) return false;
      
      if (isError !== undefined && log.isError !== isError) return false;
      if (isWarning !== undefined && log.isWarning !== isWarning) return false;
      
      return true;
    });
  }
}

/**
 * Run a function with log capture and return the result along with captured logs
 * This is useful for testing functions that log
 * 
 * @param fn The function to run
 * @returns An object with the function result and captured logs
 * 
 * @example
 * const { result, agentLogs, cliLogs } = await withLogCapture(() => {
 *   // some function that logs
 *   return "result";
 * });
 */
export async function withLogCapture<T>(fn: () => T | Promise<T>): Promise<{
  result: T;
  agentLogs: CapturedAgentLog[];
  cliLogs: CapturedCliLog[];
}> {
  const logCapture = new LogCapture();
  try {
    logCapture.start();
    const result = await fn();
    return {
      result,
      agentLogs: logCapture.getAgentLogs(),
      cliLogs: logCapture.getCliLogs()
    };
  } finally {
    logCapture.stop();
  }
}

/**
 * Create mock log functions for testing
 * This is useful when you want to test code that uses the logger
 * without actually logging anything
 * 
 * @returns An object with mock log functions
 * 
 * @example
 * const mockLog = createMockLog();
 * // Replace the real logger with the mock in your test
 * jest.spyOn(logger, 'log').mockImplementation(() => mockLog);
 */
export function createMockLog() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    cli: jest.fn(),
    cliWarn: jest.fn(),
    cliError: jest.fn(),
    agent: jest.fn()
  };
}

/**
 * Simple utility for temporarily capturing console output during tests
 * Useful for legacy tests that still expect to capture console output
 */
export class ConsoleCapture {
  private originalConsoleLog: typeof console.log;
  private originalConsoleError: typeof console.error;
  private originalConsoleWarn: typeof console.warn;
  
  private logOutput: string[] = [];
  private errorOutput: string[] = [];
  private warnOutput: string[] = [];
  
  constructor() {
    this.originalConsoleLog = console.log;
    this.originalConsoleError = console.error;
    this.originalConsoleWarn = console.warn;
  }
  
  start(): void {
    this.logOutput = [];
    this.errorOutput = [];
    this.warnOutput = [];
    
    console.log = (...args: any[]) => {
      this.logOutput.push(args.map(arg => String(arg)).join(" "));
    };
    
    console.error = (...args: any[]) => {
      this.errorOutput.push(args.map(arg => String(arg)).join(" "));
    };
    
    console.warn = (...args: any[]) => {
      this.warnOutput.push(args.map(arg => String(arg)).join(" "));
    };
  }
  
  stop(): void {
    console.log = this.originalConsoleLog;
    console.error = this.originalConsoleError;
    console.warn = this.originalConsoleWarn;
  }
  
  getLogOutput(): string[] {
    return [...this.logOutput];
  }
  
  getErrorOutput(): string[] {
    return [...this.errorOutput];
  }
  
  getWarnOutput(): string[] {
    return [...this.warnOutput];
  }
} 
