#!/usr/bin/env bun

/**
 * Test script to verify hybrid backend functionality
 */

import { createHybridBackend } from "./src/domain/tasks/hybridBackendWrapper.ts";
import { createJsonFileTaskBackend } from "./src/domain/tasks/jsonFileTaskBackend.ts";

async function testHybridBackend() {
  console.log("🧪 Testing Hybrid Backend Architecture...");
  
  try {
    // Create a JSON backend
    const jsonBackend = createJsonFileTaskBackend({
      workspacePath: "/tmp/test-hybrid",
      name: "json-file"
    });
    
    // Wrap it with metadata capabilities
    const hybridBackend = createHybridBackend(jsonBackend, {
      databasePath: "/tmp/test-hybrid-metadata.db"
    });
    
    // Initialize the hybrid backend
    await hybridBackend.initialize();
    
    // Test basic capabilities
    const capabilities = hybridBackend.getCapabilities();
    console.log("✅ Capabilities:", {
      isHybridBackend: capabilities.isHybridBackend,
      supportsMetadataQuery: capabilities.supportsMetadataQuery,
      specStorageType: capabilities.specStorageType,
      metadataStorageType: capabilities.metadataStorageType
    });
    
    // Test metadata operations
    const testMetadata = {
      taskId: "test-123",
      status: "IN-PROGRESS",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await hybridBackend.setTaskMetadata("test-123", testMetadata);
    const retrievedMetadata = await hybridBackend.getTaskMetadata("test-123");
    
    console.log("✅ Metadata Storage Test:", {
      stored: testMetadata,
      retrieved: retrievedMetadata,
      match: JSON.stringify(testMetadata) === JSON.stringify(retrievedMetadata)
    });
    
    console.log("🎉 Hybrid Backend Architecture Working!");
    return true;
    
  } catch (error) {
    console.error("❌ Hybrid Backend Test Failed:", error.message);
    return false;
  }
}

testHybridBackend().then(success => {
  process.exit(success ? 0 : 1);
});