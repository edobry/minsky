#!/usr/bin/env bun

/**
 * Debug script for session detection
 */

import { getSessionFromRepo, isSessionRepository } from './src/domain/workspace';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function debugSessionDetection() {
  try {
    const cwd = process.cwd();
    console.log(`Current directory: ${cwd}`);
    
    // Check if git root is detected correctly
    try {
      const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd });
      console.log(`\nGit root: ${stdout.trim()}`);
      
      // Check if the path matches expected pattern
      const xdgStateHome = process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state`;
      const minskyPath = `${xdgStateHome}/minsky/git`;
      console.log(`Expected minsky path prefix: ${minskyPath}`);
      
      if (stdout.trim().startsWith(minskyPath)) {
        console.log('✅ Path starts with minsky path - should be detected as session repo');
      } else {
        console.log('❌ Path does NOT start with minsky path');
      }
    } catch (error) {
      console.error('Error getting git root:', error);
    }
    
    // Check isSessionRepository directly
    const isSessionRepo = await isSessionRepository(cwd);
    console.log(`\nisSessionRepository result: ${isSessionRepo}`);
    
    // Check getSessionFromRepo directly
    const sessionInfo = await getSessionFromRepo(cwd);
    console.log('\ngetSessionFromRepo result:');
    console.log(sessionInfo);
    
    if (sessionInfo) {
      console.log('✅ Session detected successfully');
    } else {
      console.log('❌ Session detection failed');
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

debugSessionDetection(); 
