/**
 * Path utilities and constants for Minsky
 * 
 * This module centralizes path computation using XDG Base Directory Specification
 * and eliminates hardcoded path segments throughout the codebase.
 */

import { join } from "path";

/**
 * Application name used in directory paths
 */
export const APP_NAME = "minsky";

/**
 * Get the XDG state home directory
 */
export function getXdgStateHome(): string {
  return process.env.XDG_STATE_HOME || join(process.env.HOME || "", ".local/state");
}

/**
 * Get the XDG config home directory
 */
export function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config");
}

/**
 * Get the base Minsky state directory
 */
export function getMinskyStateDir(): string {
  return join(getXdgStateHome(), APP_NAME);
}

/**
 * Get the base Minsky config directory
 */
export function getMinskyConfigDir(): string {
  return join(getXdgConfigHome(), APP_NAME);
}

/**
 * Get the default session database path
 */
export function getSessionDbPath(): string {
  return join(getMinskyStateDir(), "sessions.db");
}

/**
 * Get the sessions directory path
 */
export function getSessionsDir(): string {
  return join(getMinskyStateDir(), "sessions");
}

/**
 * Get a specific session directory path
 */
export function getSessionDir(sessionId: string): string {
  return join(getSessionsDir(), sessionId);
} 
