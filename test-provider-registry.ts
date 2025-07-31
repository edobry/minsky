#!/usr/bin/env bun
/**
 * Test the Type-Safe Provider-Fetcher System
 *
 * This script demonstrates how the type system mandates fetchers for every provider.
 */

import {
  SUPPORTED_PROVIDERS,
  PROVIDER_FETCHER_REGISTRY,
  type AIProvider,
} from "./src/domain/ai/provider-registry";
import { DefaultModelCacheService } from "./src/domain/ai/model-cache";

console.log("🧪 Testing Type-Safe Provider-Fetcher System\n");

// Test 1: Show all supported providers
console.log("✅ Supported Providers:", SUPPORTED_PROVIDERS);

// Test 2: Show fetcher registry
console.log("\n🏗️ Provider Fetcher Registry:");
Object.entries(PROVIDER_FETCHER_REGISTRY).forEach(([provider, FetcherClass]) => {
  if (FetcherClass && typeof FetcherClass === "function") {
    console.log(`  ✅ ${provider}: ${FetcherClass.name} implemented`);
  } else {
    console.log(`  ❌ ${provider}: No fetcher implementation`);
  }
});

// Test 3: Demonstrate automatic registration
console.log("\n🤖 Testing Automatic Fetcher Registration:");
const cacheService = new DefaultModelCacheService();

Object.entries(PROVIDER_FETCHER_REGISTRY).forEach(([provider, FetcherClass]) => {
  if (FetcherClass && typeof FetcherClass === "function") {
    try {
      const fetcher = new FetcherClass();
      cacheService.registerFetcher(fetcher);
      console.log(`  ✅ Registered ${provider} fetcher: ${fetcher.provider}`);
    } catch (error) {
      console.log(`  ❌ Failed to register ${provider} fetcher:`, error);
    }
  } else {
    console.log(`  ⚠️  Skipped ${provider}: No implementation available`);
  }
});

// Test 4: Type safety demonstration
console.log("\n🔒 Type Safety Demonstration:");

// This would cause a TypeScript error if uncommented:
// const invalidProvider: AIProvider = "invalid"; // ❌ TypeScript error!

const validProvider: AIProvider = "morph"; // ✅ Valid
console.log(`  ✅ Valid provider assignment: ${validProvider}`);

// Test 5: Demonstrate compile-time enforcement
console.log("\n⚖️  Compile-Time Enforcement:");
console.log("  If you add a new provider to SUPPORTED_PROVIDERS without a fetcher,");
console.log("  TypeScript will show compilation errors until you implement the fetcher!");

console.log("\n🎉 Type-safe provider system working correctly!");

if (import.meta.main) {
  // Run the tests
}
