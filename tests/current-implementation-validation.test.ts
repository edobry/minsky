/**
 * Current Implementation Validation Tests
 * 
 * These tests validate the current applyEditPattern function and session edit tools
 * to identify limitations, edge cases, and failure modes for comparison with fast-apply APIs.
 */

import { describe, test, expect } from "bun:test";

/**
 * Isolated test of the applyEditPattern function
 * This duplicates the function from session-edit-tools.ts for direct testing
 */
function applyEditPattern(originalContent: string, editContent: string): string {
  // If no existing code markers, return the edit content as-is
  if (!editContent.includes("// ... existing code ...")) {
    return editContent;
  }

  // Split the edit content by the existing code marker
  const marker = "// ... existing code ...";
  const editParts = editContent.split(marker);

  // If we only have one part, something's wrong
  if (editParts.length < 2) {
    throw new Error("Invalid edit format: existing code marker found but no content sections");
  }

  let result = originalContent;

  // Process each pair of before/after content around the markers
  for (let i = 0; i < editParts.length - 1; i++) {
    const beforeContent = editParts[i]?.trim() || "";
    const afterContent = editParts[i + 1]?.trim() || "";

    // Find where to apply this edit
    if (i === 0 && beforeContent) {
      // First section - match from the beginning
      const startIndex = result.indexOf(beforeContent);
      if (startIndex === -1) {
        throw new Error(`Could not find content to match: "${beforeContent.substring(0, 50)}..."`);
      }

      // Find the end of the after content
      let endIndex = result.length;
      if (i < editParts.length - 2) {
        // There's another edit section, find where it starts
        const nextBefore = editParts[i + 2]?.trim() || "";
        const nextStart = result.indexOf(nextBefore, startIndex + beforeContent.length);
        if (nextStart !== -1) {
          endIndex = nextStart;
        }
      } else if (afterContent) {
        // Last section with after content
        const afterIndex = result.lastIndexOf(afterContent);
        if (afterIndex !== -1) {
          endIndex = afterIndex + afterContent.length;
        }
      }

      // Apply the edit
      result = `${result.substring(0, startIndex) + beforeContent}\n${result.substring(endIndex)}`;
    } else if (i === editParts.length - 2 && !afterContent) {
      // Last section with no after content - append
      result = `${result}\n${beforeContent}`;
    } else {
      // Middle sections - need to find and replace between markers
      // This is a more complex case that needs careful handling
      // For now, we'll do a simple implementation
      const searchStart = beforeContent || "";
      const searchEnd = afterContent || "";

      if (searchStart) {
        const startIdx = result.indexOf(searchStart);
        if (startIdx === -1) {
          throw new Error(`Could not find content to match: "${searchStart.substring(0, 50)}..."`);
        }

        let endIdx = result.length;
        if (searchEnd) {
          const tempEndIdx = result.indexOf(searchEnd, startIdx + searchStart.length);
          if (tempEndIdx !== -1) {
            endIdx = tempEndIdx + searchEnd.length;
          }
        }

        result = `${result.substring(0, startIdx) + searchStart}\n${
          searchEnd
        }${endIdx < result.length ? result.substring(endIdx) : ""}`;
      }
    }
  }

  return result;
}

describe("Current Implementation Performance Tests", () => {
  test("should handle simple single marker edit", () => {
    const original = `function test() {
  console.log("before");
  console.log("after");
}`;

    const edit = `function test() {
  console.log("before");
  console.log("new middle line");
  // ... existing code ...
}`;

    const result = applyEditPattern(original, edit);
    
    // This test validates basic functionality
    expect(result).toContain("new middle line");
  });

  test("should fail with ambiguous content matching", () => {
    const original = `function test() {
  console.log("debug");
  console.log("debug");
  console.log("debug");
}`;

    const edit = `function test() {
  console.log("debug");
  console.log("NEW LINE");
  // ... existing code ...
}`;

    // This should demonstrate the indexOf issue with duplicate content
    expect(() => applyEditPattern(original, edit)).not.toThrow();
    
    const result = applyEditPattern(original, edit);
    // Verify it only modifies the first occurrence (potential issue)
    const debugOccurrences = (result.match(/console\.log\("debug"\)/g) || []).length;
    expect(debugOccurrences).toBe(2); // Should reduce from 3 to 2
  });

  test("should struggle with complex multi-marker patterns", () => {
    const original = `class TestClass {
  constructor() {
    this.value = 0;
  }
  
  method1() {
    return this.value;
  }
  
  method2() {
    return this.value * 2;
  }
}`;

    const edit = `class TestClass {
  constructor() {
    this.value = 0;
    this.initialized = true;
  }
  
  // ... existing code ...
  
  method2() {
    console.log("calling method2");
    // ... existing code ...
  }
  
  // ... existing code ...
}`;

    // This complex pattern may fail or produce unexpected results
    expect(() => applyEditPattern(original, edit)).not.toThrow();
  });

  test("should demonstrate performance issues with large content", () => {
    // Create large content to test performance
    const largeContent = "console.log('line');\n".repeat(10000);
    const original = `function bigFunction() {\n${largeContent}}`;
    
    const edit = `function bigFunction() {
  console.log("start");
  // ... existing code ...
}`;

    const startTime = performance.now();
    const result = applyEditPattern(original, edit);
    const endTime = performance.now();
    
    // Document performance characteristics
    const duration = endTime - startTime;
    console.log(`Large file edit took ${duration}ms for ${original.length} characters`);
    
    expect(result).toContain("start");
    expect(duration).toBeLessThan(1000); // Should complete within 1 second
  });

  test("should fail with Unicode and special characters", () => {
    const original = `function test() {
  console.log("emoji: 🚀");
  console.log("unicode: αβγ");
  console.log("special: \\n\\t\\"");
}`;

    const edit = `function test() {
  console.log("emoji: 🚀");
  console.log("ADDED LINE");
  // ... existing code ...
}`;

    // Test Unicode handling
    expect(() => applyEditPattern(original, edit)).not.toThrow();
    
    const result = applyEditPattern(original, edit);
    expect(result).toContain("🚀");
    expect(result).toContain("αβγ");
    expect(result).toContain("ADDED LINE");
  });

  test("should document edge case with similar content blocks", () => {
    const original = `function process() {
  if (condition) {
    doSomething();
  }
  
  if (condition) {
    doSomethingElse();
  }
}`;

    const edit = `function process() {
  if (condition) {
    doSomething();
    console.log("added to first block");
  }
  
  // ... existing code ...
}`;

    // This demonstrates the indexOf problem with similar structures
    const result = applyEditPattern(original, edit);
    
    // Verify it affects the intended block (may fail)
    expect(result).toContain("added to first block");
    
    // Count if blocks to verify only one was modified
    const ifBlocks = (result.match(/if \(condition\)/g) || []).length;
    expect(ifBlocks).toBe(2); // Should still have both blocks
  });
});

describe("Edge Case Documentation", () => {
  test("should document nested marker limitation", () => {
    const original = `function outer() {
  function inner() {
    return "value";
  }
  return inner();
}`;

    const edit = `function outer() {
  // ... existing code ...
  console.log("debug");
  // ... existing code ...
}`;

    // This pattern should work but is limited
    expect(() => applyEditPattern(original, edit)).not.toThrow();
  });

  test("should document whitespace sensitivity", () => {
    const original = `function test() {
    console.log("test");
}`;

    const edit = `function test() {
  console.log("test");  // Different indentation
  console.log("added");
  // ... existing code ...
}`;

    // Whitespace differences may cause matching issues
    const result = applyEditPattern(original, edit);
    expect(result).toContain("added");
  });

  test("should document marker placement sensitivity", () => {
    const original = `function test() {
  let a = 1;
  let b = 2;
  return a + b;
}`;

    const edit = `function test() {
  let a = 1;
  let c = 3; // Add this line
// ... existing code ...
}`;

    // Marker placement affects behavior
    const result = applyEditPattern(original, edit);
    expect(result).toContain("let c = 3");
  });
});

describe("Performance Baseline Measurements", () => {
  const testSizes = [
    { name: "small", size: 1000 }, // 1KB
    { name: "medium", size: 50000 }, // 50KB  
    { name: "large", size: 500000 }, // 500KB
  ];

  testSizes.forEach(({ name, size }) => {
    test(`should measure ${name} file performance (${size} chars)`, () => {
      const content = "console.log('line');\n".repeat(size / 20);
      const original = `function test() {\n${content}}`;
      
      const edit = `function test() {
  console.log("start");
  // ... existing code ...
}`;

      const startTime = performance.now();
      const result = applyEditPattern(original, edit);
      const endTime = performance.now();
      
      const duration = endTime - startTime;
      console.log(`${name} file (${original.length} chars) took ${duration}ms`);
      
      expect(result).toContain("start");
      
      // Document performance expectations
      if (name === "small") expect(duration).toBeLessThan(100);
      if (name === "medium") expect(duration).toBeLessThan(500);
      if (name === "large") expect(duration).toBeLessThan(2000);
    });
  });
});

export { applyEditPattern }; 
