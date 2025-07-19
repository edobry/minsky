// config-setup.ts - Must be imported first to set NODE_CONFIG_DIR before any other imports
// This sets up hierarchical configuration with app defaults + user overrides

import { homedir } from "os";
import { join, dirname } from "path";
import { delimiter } from "path";
import { fileURLToPath } from "url";

// Set NODE_ENV=test for testing to ensure consistent configuration loading
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}

// Find project config directory relative to this file's location
// This file is in src/, so project root is one level up
const currentFileDir = dirname(__filename);
const projectRoot = join(currentFileDir, "..");
const projectConfigDir = join(projectRoot, "config");

// Calculate user config directory using XDG standards
const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const userConfigDir = join(xdgConfigHome, "minsky");

// Test with just project config first
const configDirs = projectConfigDir;

// Set up hierarchical config directories - this MUST happen before any imports that might use config
process.env.NODE_CONFIG_DIR = configDirs;
