#!/usr/bin/env bun

/**
 * Test script for Task #309 semantic error handling implementation
 *
 * This script validates that our semantic error handling works correctly
 * by directly testing the modified modules in the session workspace.
 */

import { SemanticErrorClassifier, ErrorContext } from "./src/utils/semantic-error-classifier";
import {
  SemanticErrorCode,
  FILESYSTEM_ERROR_MAPPINGS,
  SESSION_ERROR_MAPPINGS,
} from "./src/types/semantic-errors";

console.log("🧪 Testing Task #309: Semantic Error Handling Implementation\n");

async function testFilesystemErrorClassification() {
  console.log("📁 Testing Filesystem Error Classification...");

  // Test ENOENT file not found
  const fileNotFoundError = {
    code: "ENOENT",
    message: "ENOENT: no such file or directory, open '/test/file.txt'",
  };

  const fileContext: ErrorContext = {
    operation: "read_file",
    path: "/test/file.txt",
    session: "test-session",
  };

  const fileResult = await SemanticErrorClassifier.classifyError(fileNotFoundError, fileContext);

  console.log("✅ File Not Found Error Classification:");
  console.log(`   Error Code: ${fileResult.errorCode}`);
  console.log(`   Error Message: ${fileResult.error}`);
  console.log(`   Solutions Count: ${fileResult.solutions.length}`);
  console.log(`   Related Tools: ${fileResult.relatedTools?.join(", ") || "none"}`);
  console.log(`   Retryable: ${fileResult.retryable}`);

  // Verify it classified correctly
  if (fileResult.errorCode !== SemanticErrorCode.FILE_NOT_FOUND) {
    throw new Error(`Expected FILE_NOT_FOUND, got ${fileResult.errorCode}`);
  }

  // Test ENOENT directory not found
  const dirNotFoundError = {
    code: "ENOENT",
    message: "ENOENT: no such file or directory, mkdir '/nonexistent/path/file.txt'",
  };

  const dirContext: ErrorContext = {
    operation: "write_file",
    path: "/nonexistent/path/file.txt",
    session: "test-session",
    createDirs: false,
  };

  const dirResult = await SemanticErrorClassifier.classifyError(dirNotFoundError, dirContext);

  console.log("\n✅ Directory Not Found Error Classification:");
  console.log(`   Error Code: ${dirResult.errorCode}`);
  console.log(`   Error Message: ${dirResult.error}`);
  console.log(
    `   Solutions Include createDirs: ${dirResult.solutions.some((s) => s.includes("createDirs"))}`
  );
  console.log(`   Related Tools: ${dirResult.relatedTools?.join(", ") || "none"}`);

  if (dirResult.errorCode !== SemanticErrorCode.DIRECTORY_NOT_FOUND) {
    throw new Error(`Expected DIRECTORY_NOT_FOUND, got ${dirResult.errorCode}`);
  }

  // Test permission error
  const permError = {
    code: "EACCES",
    message: "EACCES: permission denied, open '/etc/passwd'",
  };

  const permContext: ErrorContext = {
    operation: "read_file",
    path: "/etc/passwd",
    session: "test-session",
  };

  const permResult = await SemanticErrorClassifier.classifyError(permError, permContext);

  console.log("\n✅ Permission Error Classification:");
  console.log(`   Error Code: ${permResult.errorCode}`);
  console.log(`   Error Message: ${permResult.error}`);
  console.log(`   Retryable: ${permResult.retryable}`);

  if (permResult.errorCode !== SemanticErrorCode.PERMISSION_DENIED) {
    throw new Error(`Expected PERMISSION_DENIED, got ${permResult.errorCode}`);
  }
}

async function testSessionErrorClassification() {
  console.log("\n🔗 Testing Session Error Classification...");

  const sessionError = {
    message: "Session not found: invalid-session-id",
  };

  const sessionContext: ErrorContext = {
    operation: "read_file",
    path: "/some/file.txt",
    session: "invalid-session-id",
  };

  const sessionResult = await SemanticErrorClassifier.classifyError(sessionError, sessionContext);

  console.log("✅ Session Error Classification:");
  console.log(`   Error Code: ${sessionResult.errorCode}`);
  console.log(`   Error Message: ${sessionResult.error}`);
  console.log(
    `   Solutions Include session_list: ${sessionResult.solutions.some((s) => s.includes("session_list"))}`
  );
  console.log(`   Related Tools: ${sessionResult.relatedTools?.join(", ") || "none"}`);

  if (sessionResult.errorCode !== SemanticErrorCode.SESSION_NOT_FOUND) {
    throw new Error(`Expected SESSION_NOT_FOUND, got ${sessionResult.errorCode}`);
  }
}

async function testErrorMappings() {
  console.log("\n🗺️  Testing Error Mappings...");

  // Test that all mappings are properly defined
  const filesystemMappings = Object.keys(FILESYSTEM_ERROR_MAPPINGS);
  const sessionMappings = Object.keys(SESSION_ERROR_MAPPINGS);

  console.log("✅ Error Mappings Loaded:");
  console.log(`   Filesystem Mappings: ${filesystemMappings.join(", ")}`);
  console.log(`   Session Mappings: ${sessionMappings.join(", ")}`);

  // Verify each mapping has required fields
  for (const [key, mapping] of Object.entries(FILESYSTEM_ERROR_MAPPINGS)) {
    if (
      !mapping.errorCode ||
      !mapping.message ||
      !mapping.solutions ||
      typeof mapping.retryable !== "boolean"
    ) {
      throw new Error(`Invalid mapping for ${key}: missing required fields`);
    }
  }

  console.log("   ✅ All mappings have required fields");
}

async function testPathExtraction() {
  console.log("\n📂 Testing Path Extraction...");

  const errorWithPath = {
    code: "ENOENT",
    message: "ENOENT: no such file or directory, open '/extracted/path/file.txt'",
  };

  const contextWithoutPath: ErrorContext = {
    operation: "read_file",
    session: "test-session",
    // Note: no path provided in context
  };

  const result = await SemanticErrorClassifier.classifyError(errorWithPath, contextWithoutPath);

  console.log("✅ Path Extraction:");
  console.log(`   Extracted Path: ${result.path}`);
  console.log("   Expected: /extracted/path/file.txt");

  if (result.path !== "/extracted/path/file.txt") {
    throw new Error(
      `Path extraction failed: expected "/extracted/path/file.txt", got "${result.path}"`
    );
  }
}

async function testContextAwareSolutions() {
  console.log("\n🧠 Testing Context-Aware Solutions...");

  const dirError = {
    code: "ENOENT",
    message: "ENOENT: no such file or directory, mkdir '/path/to/file.txt'",
  };

  const contextWithCreateDirsFalse: ErrorContext = {
    operation: "write_file",
    path: "/path/to/file.txt",
    session: "test-session",
    createDirs: false,
  };

  const result = await SemanticErrorClassifier.classifyError(dirError, contextWithCreateDirsFalse);

  console.log("✅ Context-Aware Solutions:");
  console.log(`   First Solution: ${result.solutions[0]}`);
  console.log(
    `   Contains createDirs suggestion: ${result.solutions[0].includes("createDirs: true")}`
  );

  if (!result.solutions[0].includes("createDirs: true")) {
    throw new Error("Context-aware solution not added for createDirs: false");
  }
}

async function runAllTests() {
  try {
    await testFilesystemErrorClassification();
    await testSessionErrorClassification();
    await testErrorMappings();
    await testPathExtraction();
    await testContextAwareSolutions();

    console.log("\n🎉 ALL TESTS PASSED!");
    console.log("\n📋 Task #309 Implementation Verification Summary:");
    console.log("   ✅ Semantic error classification working correctly");
    console.log("   ✅ Filesystem errors properly mapped to semantic codes");
    console.log("   ✅ Session errors properly handled");
    console.log("   ✅ Error mappings properly loaded and validated");
    console.log("   ✅ Path extraction from error messages working");
    console.log("   ✅ Context-aware solutions being added correctly");
    console.log("\n🚀 The semantic error handling implementation is working correctly!");
  } catch (error) {
    console.error("\n❌ TEST FAILED:");
    console.error(error);
    process.exit(1);
  }
}

// Run the tests
runAllTests();
