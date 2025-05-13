#!/usr/bin/env bun
import { Command } from "commander";
import { createSessionCommand } from "./src/commands/session";

// Create a helper function to generate a CLI with a mocked getCurrentSession
export function createMockSessionCLI(sessionName: string | null) {
  // Create a fresh getCurrentSession function for testing
  // Instead of trying to mock or override the module, we'll pass this as a dependency
  const getCurrentSession = async () => {
    return sessionName;
  };

  const program = new Command();
  program.name("minsky").description("CLI for managing Minsky workflow").version("0.1.0");

  // Use a modified session command that uses our custom getCurrentSession function
  const sessionCommand = createSessionCommand({
    getCurrentSession,
  });

  program.addCommand(sessionCommand);

  return program;
}

// Allow running this directly for testing
if (import.meta.main) {
  // Parse env var if present or use null
  const sessionName = process.env.MINSKY_TEST_CURRENT_SESSION || null;
  const program = createMockSessionCLI(sessionName);
  program.parse();
}
