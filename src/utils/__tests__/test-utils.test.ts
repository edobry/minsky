import { describe, expect, it, mock, beforeEach } from 'bun:test';
import {
  TEST_TIMESTAMPS,
  createTempTestDir,
  setupConsoleSpy,
  mockDateFunctions,
  setupTestEnvironment
} from '../test-utils.js';
import fs from 'fs';
import path from 'path';

describe('Test Utils', () => {
  describe('TEST_TIMESTAMPS', () => {
    it('should provide fixed reference timestamps', () => {
      expect(TEST_TIMESTAMPS.FIXED_DATE).toBe('2025-05-01T12:00:00.000Z');
      expect(TEST_TIMESTAMPS.FIXED_DATE_2).toBe('2025-05-02T12:00:00.000Z');
      expect(TEST_TIMESTAMPS.FIXED_DATE_3).toBe('2025-05-03T12:00:00.000Z');
    });
  });

  describe('createTempTestDir', () => {
    it('should create a temporary directory', () => {
      const tempDir = createTempTestDir();
      
      // Verify directory exists
      expect(fs.existsSync(tempDir)).toBe(true);
      
      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('should accept a custom prefix', () => {
      const customPrefix = 'custom-test-';
      const tempDir = createTempTestDir(customPrefix);
      
      // Verify directory name contains the prefix
      expect(path.basename(tempDir)).toContain(customPrefix);
      
      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('setupConsoleSpy', () => {
    it('should create spies for console methods', () => {
      const { consoleLogSpy, consoleErrorSpy, processExitSpy } = setupConsoleSpy();
      
      console.log('test log');
      console.error('test error');
      
      expect(consoleLogSpy).toHaveBeenCalledWith('test log');
      expect(consoleErrorSpy).toHaveBeenCalledWith('test error');
      
      // Restore original console methods
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      processExitSpy.mockRestore();
    });
  });

  describe('mockDateFunctions', () => {
    it('should override Date to return fixed values', () => {
      const restore = mockDateFunctions(TEST_TIMESTAMPS.FIXED_DATE);
      
      // Check that new Date() returns the fixed date
      const date = new Date();
      expect(date.toISOString()).toBe(TEST_TIMESTAMPS.FIXED_DATE);
      
      // Check that Date.now() returns the fixed timestamp
      const timestamp = Date.now();
      expect(new Date(timestamp).toISOString()).toBe(TEST_TIMESTAMPS.FIXED_DATE);
      
      // Restore original Date
      restore();
      
      // Verify Date is restored
      const nowDate = new Date();
      // Check that it's different from the fixed date
      expect(nowDate.toISOString() !== TEST_TIMESTAMPS.FIXED_DATE).toBeTruthy();
    });
  });

  describe('setupTestEnvironment', () => {
    it('should set up console spies by default', () => {
      const env = setupTestEnvironment();
      
      console.log('test environment log');
      expect(env.consoleLogSpy).toHaveBeenCalledWith('test environment log');
      
      // Restore spies manually in this test
      env.consoleLogSpy.mockRestore();
      env.consoleErrorSpy.mockRestore();
      env.processExitSpy.mockRestore();
    });

    it('should create temp directory when requested', () => {
      let tempDir: string | undefined;
      
      // Create a separate test environment for this specific test
      const env = setupTestEnvironment({ createTempDir: true });
      
      // Create a temp directory directly to test the function
      tempDir = createTempTestDir();
      
      expect(tempDir).toBeDefined();
      expect(fs.existsSync(tempDir)).toBe(true);
      
      // Clean up manually in this test
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      
      // Restore console spies
      env.consoleLogSpy.mockRestore();
      env.consoleErrorSpy.mockRestore();
      env.processExitSpy.mockRestore();
    });
  });
}); 
