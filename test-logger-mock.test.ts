/**
 * Simple test to verify logger mocking is working
 */

import { describe, test, expect } from "bun:test";
import { log } from "./src/utils/logger";
import { mockLogger } from "./tests/setup";

describe("Logger Mock Test", () => {
  test("should use mock logger instead of real logger", () => {
    // Clear any previous logs
    mockLogger._mock.clear();
    
    // Try logging something
    log.info("This should not appear in console");
    log.warn("This warning should also be captured");
    log.error("This error should be captured too");
    
    // Verify the mock captured the logs
    const allLogs = mockLogger._mock.getAllLogs();
    expect(allLogs).toHaveLength(3);
    
    const infoLogs = mockLogger._mock.getLogsByLevel("info");
    expect(infoLogs).toHaveLength(1);
    expect(infoLogs[0].message).toBe("This should not appear in console");
    
    const warnLogs = mockLogger._mock.getLogsByLevel("warn");
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0].message).toBe("This warning should also be captured");
    
    const errorLogs = mockLogger._mock.getLogsByLevel("error");
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].message).toBe("This error should be captured too");
    
    console.log("✅ Logger mock test passed - no console output from logger!");
  });
});

