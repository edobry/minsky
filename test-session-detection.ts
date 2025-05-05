#!/usr/bin/env bun

/**
 * Integration test script for session context auto-detection
 * 
 * This script demonstrates how session commands automatically detect
 * the current session when run from within a session workspace.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function runCommand(command: string): Promise<string> {
  try {
    const { stdout } = await execAsync(command);
    return stdout.trim();
  } catch (error) {
    const err = error as any;
    console.error(`Error running command: ${command}`);
    console.error(`stderr: ${err.stderr}`);
    throw error;
  }
}

async function testSessionCommands() {
  try {
    console.log('Testing session auto-detection in commands...\n');
    
    // Get the current directory to verify we're in a session
    const pwd = await runCommand('pwd');
    console.log(`Current directory: ${pwd}`);
    
    // Check if we're in a session repository
    console.log('\nChecking if current directory is a session workspace...');
    if (pwd.includes('/minsky/git/') && pwd.includes('/sessions/')) {
      console.log('✅ Current directory appears to be a session workspace');
    } else {
      console.error('❌ Not in a session workspace. Please run this script from within a session directory.');
      console.error(`   For example: cd $(minsky session dir task#XXX) && bun run test-session-detection.ts`);
      process.exit(1);
    }
    
    // Get the session name from the path
    const sessionName = pwd.split('/').pop();
    console.log(`Detected session name from path: ${sessionName}`);
    
    // Run the session dir command without arguments - should auto-detect
    console.log('\nTesting `minsky session dir` (auto-detection)...');
    const dirOutput = await runCommand('bun run src/cli.ts session dir');
    console.log(`Output: ${dirOutput}`);
    console.log(`✅ Correctly returned the current session directory`);
    
    // Run the session get command without arguments - should auto-detect
    console.log('\nTesting `minsky session get` (auto-detection)...');
    const getOutput = await runCommand('bun run src/cli.ts session get');
    console.log('Output:');
    console.log(getOutput);
    
    // Verify the output contains expected session info
    if (getOutput.includes(`Session: ${sessionName}`)) {
      console.log(`✅ Correctly identified the current session: ${sessionName}`);
    } else {
      console.error(`❌ Failed to auto-detect the current session`);
    }
    
    // Test with explicit --ignore-workspace flag
    console.log('\nTesting `minsky session dir --ignore-workspace`...');
    try {
      await runCommand('bun run src/cli.ts session dir --ignore-workspace');
      console.error('❌ Command should have failed but succeeded');
    } catch (error) {
      console.log('✅ Command correctly failed when using --ignore-workspace without a session name');
    }
    
    console.log('\nAll auto-detection tests completed successfully!');
  } catch (error) {
    console.error('Error during testing:', error);
    process.exit(1);
  }
}

testSessionCommands(); 
